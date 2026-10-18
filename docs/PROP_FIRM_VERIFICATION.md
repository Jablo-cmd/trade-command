# Prop-firm compatibility verification

Every account/program profile tracks these items. Each one starts as **unknown**, and unknown blocks live execution.

| Item | What to confirm |
|---|---|
| Automated execution | Whether algorithmic or automated order placement is allowed on this program |
| EA / API usage | Whether Expert Advisors or external APIs may place orders |
| VPS / VPN | Whether trading from a VPS, a VPN or shared IPs is allowed |
| Copying between own accounts | Whether the same signal may be traded across several of your own accounts at this and other firms |
| Pending orders | Whether limit orders are permitted, and any holding or expiry rules |
| Hedging / netting | Account mode and any rules on opposing positions |
| Instrument restrictions | Whether XAUUSD is allowed, and any lot or leverage caps |
| News / session restrictions | No-trade windows around news, weekend holding, session rules |
| Program limitations | Any other rule, such as consistency rules or max lots |

Rules for recording:
- **Permitted** and **Conditional** require a **source** (rules page URL, support-ticket reference) and a **verification date**. The UI and the database both enforce this.
- Re-verify periodically. Firms change rules, and the date shows how old the evidence is.
- The app never asserts that a firm permits a method.

Out of scope, permanently: randomisation, price or timing jitter, or any feature intended to disguise copying or evade firm detection.

## Items still requiring verification

All of them, for every real firm. No real firm rules are recorded in this repository.
