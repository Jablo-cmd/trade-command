# MT5 connector — Windows VPS setup (phone-friendly)

The connector is a small Python program that runs next to your MT5 terminal on a Windows
VPS. It takes orders queued by the Trade Command app, re-checks every one against live MT5
data and your risk limits, places it, and reports fills and positions back to the app.

> **Start with a demo account.** The connector refuses real-money accounts unless you set
> `"allow_real_accounts": true` in its config. Only do that after the demo checks at the end
> of this guide pass, and only for firms whose rules you have verified in the app.

## What you need

| Item | Notes |
|---|---|
| Windows VPS | Windows Server 2019/2022, 2 vCPU, 4 GB RAM is enough for 3–5 MT5 terminals. Choose a London or Amsterdam location for FTMO. |
| Remote Desktop app on your phone | "Windows App" (Microsoft, formerly Remote Desktop) on Android/iOS. |
| MT5 login details | Account number, password and exact server name for each account. |
| Supabase service key | Dashboard → Project Settings → API Keys → **secret** / `service_role` key. Only ever paste it on the VPS. |

## 1. Connect to the VPS from your phone
1. Install **Windows App** from the Play Store or App Store.
2. Tap **+ → Add PC**. Enter the VPS IP address, username and password from your VPS provider.
3. Connect. Turn your phone sideways; pinch to zoom.

## 2. Install MT5 once per account (portable mode)
One MT5 terminal can be logged into only one account at a time, so each account gets its own copy.
1. On the VPS, open Edge and download MT5 from your firm (FTMO: Client Area → Downloads).
2. Install it into its own folder, e.g. `C:\MT5\ftmo-demo-1`.
3. Open it, log in to the **demo** account, and tick **Save password**.
4. **Tools → Options → Expert Advisors** → tick **Allow algorithmic trading**. Click the **Algo Trading** button in the toolbar so it turns green.
5. Open **XAUUSD** in Market Watch (right-click → Show All if hidden). Note its exact name; some brokers add a suffix like `XAUUSD.r`.
6. Repeat for each account, each in its own folder.

## 3. Install Python and the connector
1. Download **Python 3.12** for Windows from python.org. During install tick **Add python.exe to PATH**.
2. Download the repository: Edge → `https://github.com/Jablo-cmd/trade-command` → **Code → Download ZIP**. Extract it to `C:\trade-command`.
3. Open **Command Prompt** and run:
   ```
   cd C:\trade-command\connector
   py -m pip install -r requirements.txt
   ```

## 4. Store the secrets (never in a file)
In Command Prompt, run each line, replacing the values:
```
py -c "import keyring; keyring.set_password('trade-command','TC_SUPABASE_SERVICE_KEY','PASTE_SERVICE_KEY')"
py -c "import keyring; keyring.set_password('trade-command','TC_MT5_PASSWORD_FTMO_DEMO_1','PASTE_MT5_PASSWORD')"
```
They go into Windows Credential Manager. The MT5 password is optional if the terminal already saved it.

## 5. Configure one file per account
1. In the app, open **Accounts**, add the account, set **Execution mode → Live automated**, and link its compatibility profile. Copy the account's ID (shown on the account card).
2. On the VPS, copy `connector\accounts\example.json` to `connector\accounts\ftmo-demo-1.json` and edit it in Notepad:
   - `trading_account_id`: the ID from the app
   - `mt5_login`, `mt5_server`: exactly as shown in MT5 (File → Login)
   - `terminal_path`: e.g. `C:\\MT5\\ftmo-demo-1\\terminal64.exe` (double backslashes)
   - `symbols`: map `XAUUSD` to the broker's exact symbol name
   - `server_day_utc_offset_hours`: the broker's server-time offset used for daily-loss limits (FTMO: 2 in winter, 3 in summer — check the MT5 Market Watch clock)
   - leave `allow_real_accounts` as `false`

## 6. Run it
```
cd C:\trade-command\connector
py -m tradecommand_connector --config accounts\ftmo-demo-1.json --once
```
`--once` runs a single check. You should see the account turn **Connected** in the app. Then run it continuously (no `--once`). One Command Prompt window per account.

To start automatically after a VPS reboot, create a Task Scheduler task per account: *At startup → Start a program* `py` with arguments `-m tradecommand_connector --config accounts\ftmo-demo-1.json` and *Start in* `C:\trade-command\connector`.

## 7. Demo checklist before any real account
- [ ] App shows the account **Connected** with a live XAUUSD quote.
- [ ] A staged signal places limits at the right prices, SL and TP, and correct lot sizes.
- [ ] A fill shows in the app; SL/TP match the actual fill price.
- [ ] Cancel works; a cancel after a fill is refused with a clear reason.
- [ ] Extended TP moves the TP and leaves the SL unchanged.
- [ ] Emergency disable cancels every pending order and blocks new ones.
- [ ] Stopping the connector makes the app show the account as not connected.
- [ ] The firm's rules for automated execution, EA/API use, VPS and copying your own accounts are recorded **with a source and date** in the app's compatibility section.

## What the connector checks before every order
Owner match · emergency switch · account trading enabled and set to live automated · every
firm rule verified with evidence · real-money accounts blocked unless allowed · MT5 algo trading
on · signal still active and matching · symbol tradable with a fresh quote · SL/TP recomputed from
the strategy and compared to the request · broker tick size and stop distance · lot size within
max risk per trade, aggregate, daily-loss and drawdown limits using **live** MT5 balance, equity,
today's deals and every open position and pending order on the account (including manual ones) ·
no duplicate of the same order. Anything that fails is rejected with its reasons and shown in the app.
