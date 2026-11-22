# Counter Club

A self-service ordering kiosk, kitchen order tickets, counter controls and a customer pickup display.

[Open the interactive demo](https://thebestjob.github.io/fastfood-kiosk/)

Try **Kiosk → Kitchen → Counter → Order display**. Place a sample order, start preparing it, mark it ready, call its number, record a sample payment and mark it collected. Open different tabs in the same browser to watch updates. The public demo stores sample data in your browser. Clearing the site's data resets the demo.

## Run on a shop network

Install Python 3.10+ and run from the repository root.

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
export KIOSK_STAFF_PIN='replace-with-a-strong-staff-pin'
python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

Open `http://SHOP-PC-IP:8000` on devices on the same network. Open `/#kiosk` on the touchscreen, `/#kitchen` in the kitchen, `/#owner` at the counter, and `/#display` on the pickup screen. Enter the configured PIN on staff screens. Use a dedicated shop LAN, restrict the port to that network, and keep guest Wi-Fi separate. For a shared or untrusted network, configure HTTPS and network access controls before use.

The server creates `shop.sqlite3` on first run. Set `KIOSK_DB` to a persistent path to change this location. Use SQLite's online backup command, for example `sqlite3 shop.sqlite3 ".backup backup.sqlite3"`, and copy backups to another device.

## Printing and payments

Optional Linux CUPS queues can print customer slips and kitchen tickets. Set `KIOSK_SLIP_PRINTER` and/or `KIOSK_KITCHEN_PRINTER` to the configured queue names and restart the server. Verify the queues with `lpstat -p`. The Counter screen reports failed or uncertain submissions and offers ticket reprints. After a job is accepted by CUPS, check its delivery and paper status in CUPS. The browser can also print a customer slip from the confirmation screen.

Record cash and card payments separately from order preparation. Card payments are completed on the shop's existing terminal. The customer slip is an order confirmation. Fiscal receipts, invoice issuance, refunds and card terminal integration require a separate workflow. Use the Counter CSV export for order records.

## Deploy the demo

In the repository's **Settings → Pages**, select **Deploy from a branch**, then **main** and **/docs**. The public site uses the same HTML, CSS and JavaScript as the shop server, with browser storage in place of the live API. There are no external runtime services in demo mode.

For a quick preview without shop mode, run `python -m http.server 8080 --directory docs` and open `http://localhost:8080`.
