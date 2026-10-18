# MT5 connector requirements (research notes, not implemented)

**Status:** no MT5 connection exists in this repository. `UnavailableMt5Provider` returns `unsupported` for every call. Treat everything below as requirements to verify before building anything.

## What the official MetaTrader 5 Python integration needs

- The `MetaTrader5` Python package (installed with pip) talks to a **locally installed MetaTrader 5 terminal**. `initialize()` connects to a terminal, can launch one if needed, and can log into a specific account; `login()` switches accounts on an open connection; `shutdown()` disconnects. ([MQL5 Python integration](https://docs.mql4.com/mql5_language/mql5_functions/mql5_python), [MQL5 book](https://www.mql5.com/de/book/advanced/python/python_funcs_overview))
- In practice this means a **Windows host** (a VPS or dedicated machine) running the terminal(s) with the Python worker beside them. It cannot run in a browser, on Android, or in a Supabase Edge Function.
- One terminal session is logged into one account at a time. Running many accounts concurrently implies multiple terminal installations, for example in portable mode. A MetaQuotes reply on the MQL5 forum (2020) reported that `initialize()` attached to the last-started instance when several portable terminals ran. **Verify current behaviour** before designing around it. ([forum thread](https://mql5.com/en/forum/393357/29246235))
- Broker server names, symbol suffixes (for example `XAUUSD.r`) and contract specs differ per broker. Read them via `symbol_info()` from each terminal rather than assuming them.

## Alternatives (each needs verification)

- **EA inside the terminal (MQL5)** that polls a backend over HTTPS (`WebRequest` requires the URL to be allow-listed in terminal settings). This still needs a running terminal host.
- **Third-party cloud MT5 bridges.** These require giving the account password to a third party. Check each prop firm's rules on third-party access and VPS/IP use before considering one.
- MetaQuotes Manager/Server APIs are broker-side products and are not available to traders.

## Security requirements for any connector

- Store account passwords only in a secret manager or an OS credential store on the connector host. Never store them in Postgres columns, localStorage, logs or Git.
- Use the service role only on the connector host or backend. Never ship it to the browser.
- Before every submit, check: kill switch, eligibility, fresh provider metrics and quote, risk re-validation, and an idempotency key.
- Log every request and response to `execution_events`, with secrets redacted.

## Prerequisite per account

The account's compatibility profile must record verified evidence, with source and date, for automated execution, EA/API usage, VPS/VPN, copying between own accounts, and pending orders. Until then, `live_automated` stays blocked.
