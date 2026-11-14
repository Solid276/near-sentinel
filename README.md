\# NEAR Sentinel



\*\*An AI-powered DeFi risk intelligence and early-warning agent for NEAR.\*\*



NEAR Sentinel monitors NEAR lending positions, evaluates collateral and liquidation risk, and uses an AI Risk Analyst to turn validated risk data into understandable assessments and recommended actions.



It currently provides a read-only lending risk monitor through a web dashboard and Telegram bot.



\## What NEAR Sentinel does



\### 1. Lending risk monitoring



\- Tracks NEAR lending positions through mainnet read-only RPC calls.

\- Calculates health factors using collateral values, debt values, and on-chain asset volatility ratios.

\- Evaluates adjusted collateral and adjusted debt.

\- Validates oracle price availability and freshness.

\- Identifies collateral liquidation sensitivity.

\- Supports configurable warning and critical health-factor thresholds.

\- Sends Telegram alerts when monitored positions cross configured risk thresholds.

\- Handles recovery and alert escalation states.



The current lending integration reads the underlying contract at `contract.main.burrow.near`. The user-facing lending product is referred to as \*\*RHEA Lend\*\*.



\### 2. AI Risk Analyst



The AI Risk Analyst uses NEAR AI Cloud to interpret validated risk snapshots produced by the deterministic risk engine.



It provides:



\- A natural-language assessment of a lending position.

\- Key risk findings.

\- Recommended actions.

\- Data-quality context.



The AI does not calculate or independently invent financial metrics. The deterministic risk engine supplies the underlying values, while the AI explains their significance.



\### 3. Web dashboard



The web interface provides:



\- NEAR account lookup.

\- Lending health-factor monitoring.

\- Collateral and debt metrics.

\- Position information.

\- AI-generated risk assessments.

\- A link to the Telegram bot.



\### 4. Telegram bot



The Telegram bot supports:



| Command | Function |

|---|---|

| `/start` | Start the bot and display its menu |

| `/help` | Show available commands |

| `/track account.near` | Start monitoring a NEAR account |

| `/status` | Fetch the latest lending risk snapshot |

| `/analyze` | Request an AI risk assessment |

| `/threshold 125 110` | Configure warning and critical thresholds |

| `/untrack` | Stop monitoring the account |



The interactive menu also provides Track, Status, Analyze, Threshold, and Stop tracking actions.



\## Architecture



```text

&#x20;                NEAR Mainnet

&#x20;                     |

&#x20;                NEAR RPC

&#x20;                     |

&#x20;            Lending Position Data

&#x20;                     |

&#x20;             Oracle Price Data

&#x20;                     |

&#x20;                     v

&#x20;            Deterministic Risk Engine

&#x20;                     |

&#x20;             Validated Risk Snapshot

&#x20;                /          \\

&#x20;               /            \\

&#x20;              v              v

&#x20;       AI Risk Analyst    Monitoring Engine

&#x20;       (NEAR AI Cloud)         |

&#x20;              |                |

&#x20;              v                v

&#x20;       Risk Assessment    Telegram Alerts

&#x20;              |

&#x20;              v

&#x20;         Web Dashboard

