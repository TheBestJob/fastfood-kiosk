import asyncio
from contextlib import asynccontextmanager, contextmanager
from datetime import datetime, timezone
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
from threading import Event, Thread
from typing import Annotated, Literal

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "docs"
DB = Path(os.getenv("KIOSK_DB", "shop.sqlite3"))
PIN = os.getenv("KIOSK_STAFF_PIN", "")
SLIP_PRINTER = os.getenv("KIOSK_SLIP_PRINTER")
KITCHEN_PRINTER = os.getenv("KIOSK_KITCHEN_PRINTER")
Identifier = Annotated[str, Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")]


class Line(BaseModel):
    id: Identifier
    quantity: int = Field(ge=1, le=30)
    note: str = Field(default="", max_length=140)


class Item(BaseModel):
    id: Identifier
    name: str = Field(min_length=1, max_length=80)
    category: str = Field(min_length=1, max_length=40)
    description: str = Field(default="", max_length=200)
    price: int = Field(ge=1, le=99999)
    active: bool


class Offer(BaseModel):
    name: str = Field(max_length=80)
    percent: int = Field(ge=0, le=90)


class Action(BaseModel):
    type: Literal["place", "menu", "offer", "status", "pay", "call", "reprint"]
    id: Identifier | None = None
    items: list[Line] = Field(default_factory=list, max_length=100)
    expectedTotal: int | None = Field(default=None, ge=0)
    item: Item | None = None
    offer: Offer | None = None
    status: Literal["Preparing", "Ready", "Collected", "Cancelled"] | None = None
    method: Literal["Cash", "Card"] | None = None
    callId: Identifier | None = None


@contextmanager
def connection():
    database = sqlite3.connect(DB, timeout=8)
    database.row_factory = sqlite3.Row
    try:
        with database:
            yield database
    finally:
        database.close()


def now():
    return datetime.now(timezone.utc).isoformat()


def queue_ticket(database, order, kind, printer):
    if not printer:
        return
    lines = ["KITCHEN ORDER TICKET" if kind == "kitchen" else "ORDER CONFIRMATION", order["token"], ""]
    for item in order["items"]:
        lines.append(f'{item["quantity"]} x {item["name"]}')
        if item["note"]:
            lines.append(f'  {item["note"]}')
    if kind == "slip":
        lines += ["", f'Total PLN {order["total"] / 100:.2f}', "Pay at counter"]
    clean = "\n".join(re.sub(r"[\x00-\x1f\x7f]", " ", line) for line in lines)
    database.execute(
        "INSERT INTO print_jobs (token, kind, printer, body) VALUES (?, ?, ?, ?)",
        (order["token"], kind, printer, clean + "\n"),
    )


def print_worker(stop):
    while not stop.wait(0.5):
        with connection() as database:
            database.execute("BEGIN IMMEDIATE")
            job = database.execute("SELECT * FROM print_jobs WHERE status='queued' ORDER BY id LIMIT 1").fetchone()
            if job is None:
                continue
            database.execute("UPDATE print_jobs SET status='sending' WHERE id=?", (job["id"],))
        try:
            subprocess.run(
                ["lp", "-d", job["printer"]],
                input=job["body"], text=True, check=True, capture_output=True, timeout=15,
            )
            status = "submitted"
        except (OSError, subprocess.SubprocessError):
            status = "failed"
        with connection() as database:
            database.execute("UPDATE print_jobs SET status=? WHERE id=?", (status, job["id"]))
            database.execute("UPDATE shop SET revision=revision+1 WHERE id=1")


@asynccontextmanager
async def lifespan(_):
    if len(PIN) < 6:
        raise RuntimeError("Set KIOSK_STAFF_PIN to a PIN of at least six characters.")
    with connection() as database:
        database.execute("PRAGMA journal_mode=WAL")
        database.executescript("""
            CREATE TABLE IF NOT EXISTS shop (
                id INTEGER PRIMARY KEY CHECK (id=1),
                state TEXT NOT NULL,
                revision INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS print_jobs (
                id INTEGER PRIMARY KEY, token TEXT NOT NULL, kind TEXT NOT NULL,
                printer TEXT NOT NULL, body TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued'
            );
        """)
        database.execute("INSERT OR IGNORE INTO shop (id,state) VALUES (1,?)", ((WEB / "seed.json").read_text(),))
        database.execute("UPDATE print_jobs SET status='uncertain' WHERE status='sending'")
    stop = Event()
    worker = Thread(target=print_worker, args=(stop,), daemon=True)
    if SLIP_PRINTER or KITCHEN_PRINTER:
        worker.start()
    try:
        yield
    finally:
        stop.set()
        if worker.is_alive():
            await asyncio.to_thread(worker.join)


app = FastAPI(title="Counter Club", lifespan=lifespan)


@app.get("/", response_class=HTMLResponse)
def home():
    html = (WEB / "index.html").read_text().replace("</head>", '<meta name="local-server" content="true">\n</head>')
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


def require_staff(pin):
    if not hmac.compare_digest(pin.encode(), PIN.encode()):
        raise HTTPException(401, "Enter the staff PIN.")


@app.get("/api/state")
def state(screen: str = "kiosk", x_staff_pin: str = Header(default="")):
    if screen in ("owner", "kitchen"):
        require_staff(x_staff_pin)
    with connection() as database:
        data = json.loads(database.execute("SELECT state FROM shop WHERE id=1").fetchone()["state"])
        if screen == "owner":
            data["printers"] = {"slip": bool(SLIP_PRINTER), "kitchen": bool(KITCHEN_PRINTER)}
            data["printIssues"] = [dict(row) for row in database.execute(
                "SELECT token, kind, status FROM print_jobs "
                "WHERE status IN ('failed','uncertain') "
                "AND id IN (SELECT MAX(id) FROM print_jobs GROUP BY token, kind) "
                "ORDER BY id DESC LIMIT 10"
            )]
    if screen == "owner":
        result = data
    elif screen == "kitchen":
        result = {"orders": data["orders"]}
    elif screen == "display":
        result = {"call": data["call"], "orders": [
            {"token": order["token"], "status": order["status"]}
            for order in data["orders"] if order["status"] in ("Preparing", "Ready")
        ]}
    else:
        result = {"menu": [item for item in data["menu"] if item["active"]], "offer": data["offer"]}
    return JSONResponse(result, headers={"Cache-Control": "no-store"})


@app.get("/api/events")
async def events():
    def revision():
        with connection() as database:
            return database.execute("SELECT revision FROM shop WHERE id=1").fetchone()["revision"]

    async def changes():
        previous = None
        while True:
            current = await asyncio.to_thread(revision)
            if current != previous:
                yield f"event: change\ndata: {current}\n\n"
                previous = current
            else:
                yield ": keepalive\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(changes(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


def place(database, data, command):
    existing = next((order for order in data["orders"] if order["id"] == command.id), None)
    if existing:
        return existing
    if not command.id or not command.items or len({line.id for line in command.items}) != len(command.items):
        raise HTTPException(400, "Include at least one item and a valid order ID.")
    available = {item["id"]: item for item in data["menu"] if item["active"]}
    items = []
    for line in command.items:
        item = available.get(line.id)
        if item is None:
            raise HTTPException(409, "An item sold out. Update your basket and try again.")
        items.append({"name": item["name"], "price": item["price"], "quantity": line.quantity, "note": line.note})
    subtotal = sum(item["price"] * item["quantity"] for item in items)
    discount = (subtotal * data["offer"]["percent"] + 50) // 100
    if command.expectedTotal != subtotal - discount:
        raise HTTPException(409, "The price changed. Review your basket before placing the order.")
    order = {
        "id": command.id, "token": f'A{data["next"]:03d}', "items": items, "subtotal": subtotal,
        "discount": discount, "offer": data["offer"]["name"], "total": subtotal - discount,
        "status": "Queued", "payment": None, "createdAt": now(),
    }
    data["next"] += 1
    data["orders"].insert(0, order)
    queue_ticket(database, order, "slip", SLIP_PRINTER)
    queue_ticket(database, order, "kitchen", KITCHEN_PRINTER)
    return order


def manage_order(database, data, command):
    order = next((entry for entry in data["orders"] if entry["id"] == command.id), None)
    if order is None:
        raise HTTPException(404, "Order unavailable.")
    status = order["status"]
    if command.type == "reprint" and command.status is None:
        kind = "kitchen" if command.callId == "kitchen" else "slip"
        printer = KITCHEN_PRINTER if kind == "kitchen" else SLIP_PRINTER
        if not printer:
            raise HTTPException(409, "This printer is not configured.")
        queue_ticket(database, order, kind, printer)
        return
    if command.type == "pay" and command.method and not order["payment"] and status in ("Queued", "Preparing", "Ready"):
        order["payment"] = {"method": command.method, "at": now()}
        return
    if command.type == "call" and command.callId and status == "Ready":
        data["call"] = {"token": order["token"], "id": command.callId}
        return
    transitions = {"Queued": ("Preparing", "Cancelled"), "Preparing": ("Ready", "Cancelled"), "Ready": ("Collected", "Cancelled")}
    if (
        command.type != "status"
        or command.status not in transitions.get(status, ())
        or (command.status == "Collected" and not order["payment"])
        or (command.status == "Cancelled" and order["payment"])
    ):
        raise HTTPException(409, "This order cannot make that change.")
    order["status"] = command.status
    if (data["call"] or {}).get("token") == order["token"]:
        data["call"] = None


@app.post("/api/actions")
def actions(command: Action, x_staff_pin: str = Header(default="")):
    if command.type != "place":
        require_staff(x_staff_pin)
    with connection() as database:
        database.execute("BEGIN IMMEDIATE")
        data = json.loads(database.execute("SELECT state FROM shop WHERE id=1").fetchone()["state"])
        result = {}
        if command.type == "place":
            result["order"] = place(database, data, command)
            # Public receipts contain no staff order credentials or payment details.
            result["order"] = {key: value for key, value in result["order"].items() if key not in ("id", "payment", "status")}
        elif command.type == "menu" and command.item:
            item = command.item.model_dump()
            if not item["name"].strip() or not item["category"].strip():
                raise HTTPException(400, "Enter a name and category.")
            for index, entry in enumerate(data["menu"]):
                if entry["id"] == item["id"]:
                    data["menu"][index] = item
                    break
            else:
                data["menu"].append(item)
        elif command.type == "offer" and command.offer:
            data["offer"] = command.offer.model_dump()
        elif command.type in ("status", "pay", "call", "reprint"):
            manage_order(database, data, command)
        else:
            raise HTTPException(400, "Invalid action.")
        database.execute("UPDATE shop SET state=?, revision=revision+1 WHERE id=1", (json.dumps(data),))
        return result


app.mount("/", StaticFiles(directory=WEB), name="screens")
