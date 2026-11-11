# Business process flows and customer journey

Diagrams are written in Mermaid and render on GitHub.

## 1. Customer journey

| Stage | What the player does | What the platform does | Safeguard |
|-------|----------------------|------------------------|-----------|
| Discover | Opens the cycle page, tries a free demo card | Shows prizes, price, tickets left, odds, closing rule, licence details | No account needed; demo is clearly marked |
| Register | Enters phone number, OTP, sets a PIN; optionally adds next of kin | Creates a Tier 0 account | OTP rate limits; PIN stored as a hash |
| Verify | Enters NIN or BVN, allows location | Confirms 18+, one account per person, located in Niger State | Staff/exclusion register check; self-exclusion check |
| Buy | Chooses quantity, pays | Reserves, confirms payment server-side, assigns random tickets | Spending limits; per-cycle cap; idempotent |
| Scratch | Scratches or taps "Reveal" | Reveals the pre-set outcome with proof; credits any instant win | Outcome fixed before sale; reveal is once-only |
| Wait for draw | Sees "Entered in the final draw" | Auto-reveals unscratched tickets at close | Every paid ticket is entered |
| Draw | Watches the live draw page | Runs the verifiable draw with auditor countersignature | Anyone can re-run and check |
| Collect | Withdraws cash, or arranges delivery | Name-matched bank payout; tracked delivery with OTP handover | Step-up authentication; dual approval above threshold |

## 2. Prize cycle lifecycle

```mermaid
stateDiagram-v2
    [*] --> DRAFT: Cycle manager creates
    DRAFT --> SUBMITTED: Submit for approval
    SUBMITTED --> DRAFT: Sent back
    SUBMITTED --> APPROVED: Operations + Finance approve\n(model, rules, auditor, escrow funded)
    APPROVED --> COMMITTED: Tickets generated,\ncommitments published
    COMMITTED --> OPEN: Sales open\n(licence + certification gate)
    OPEN --> CLOSED: Sold out OR closing date
    CLOSED --> DRAWN: Final draw executed
    DRAWN --> SETTLING: Prizes being paid / delivered
    SETTLING --> ARCHIVED: All reconciled,\nfull ticket list published
    APPROVED --> VOID
    COMMITTED --> VOID
    OPEN --> VOID: Dual approval,\nall tickets refunded
    CLOSED --> VOID
    ARCHIVED --> [*]
    VOID --> [*]
```

Nothing about the game can be edited from `APPROVED` onward. The draw happens on the published schedule whether or not every ticket was sold.

## 3. Ticket purchase

```mermaid
sequenceDiagram
    actor P as Player
    participant W as Web app
    participant A as API
    participant G as Payment gateway
    participant D as Database

    P->>W: Choose quantity, tap Buy
    W->>A: Create order (idempotency key)
    A->>D: Check: verified, in Niger State, not excluded,<br/>within spending limits and per-cycle cap
    A->>D: Reserve quantity (10 minutes)
    A->>G: Create payment
    A-->>W: Payment page / bank details
    P->>G: Pays (card, transfer or USSD)
    G->>A: Webhook: payment succeeded
    A->>A: Verify webhook signature
    A->>G: Re-query payment (amount, currency, status)
    A->>D: ONE transaction: mark paid, post ledger entries,<br/>assign random unsold tickets
    A-->>W: Tickets issued
    W-->>P: "Your cards are ready to scratch"

    Note over A,D: Paid but no ticket available, or payment arrives after<br/>the reservation expired → automatic refund, never limbo
```

## 4. Scratch and instant prize

```mermaid
sequenceDiagram
    actor P as Player
    participant W as Web app
    participant A as API (reveal service)
    participant K as Key service (KMS)
    participant D as Database

    P->>W: Starts scratching
    W->>A: Reveal ticket
    A->>D: Lock ticket; confirm owner; already revealed?
    alt First reveal
        A->>K: Decrypt this ticket's outcome (logged)
        A->>D: ONE transaction: mark revealed,<br/>credit instant prize to ledger, audit record
    else Already revealed
        A->>D: Read stored result
    end
    A-->>W: Outcome + salt + proof
    W->>W: Verify proof against published root
    W-->>P: Scratch surface clears to show result
```

The scratch gesture only controls the animation. Calling reveal twice returns the same answer and pays once.

## 5. Final draw

```mermaid
flowchart TD
    A[Cycle closes:<br/>sold out or closing date] --> B[Auto-reveal remaining sold tickets]
    B --> C[Freeze eligible entries:<br/>paid, valid, not refunded or cancelled]
    C --> D[Publish number of entries and their hash]
    D --> E[Wait for the pre-announced<br/>public randomness round]
    E --> F[Two operators start the draw]
    F --> G[Appointed auditor countersigns]
    G --> H[Reveal the committed secret,<br/>combine with public randomness → seed]
    H --> I[Published algorithm selects winners,<br/>major prizes first]
    I --> J[Publish winners, secret, round, report]
    J --> K[Notify winners; create prize claims]
    J --> L[Anyone re-runs the draw with the verifier]
```

## 6. Cash payout

```mermaid
flowchart TD
    A[Player taps Withdraw] --> B{PIN / biometric<br/>confirmed?}
    B -- No --> X[Stop]
    B -- Yes --> C{Bank account name matches<br/>verified identity and<br/>cooling-off passed?}
    C -- No --> Y[Ask player to verify bank account]
    C -- Yes --> D{Fraud hold or<br/>exclusion match?}
    D -- Yes --> H[On hold → Compliance review]
    D -- No --> E{Above approval<br/>threshold?}
    E -- Yes --> F[Finance initiates → different<br/>Payout approver approves]
    E -- No --> G[Send to gateway]
    F --> G
    G --> I{Gateway confirms?}
    I -- Yes --> J[Ledger: winnings payable → paid.<br/>Notify player]
    I -- No --> K[Reverse in ledger, alert, retry or review]
```

## 7. Merchandise redemption

```mermaid
flowchart TD
    A[Winner notified:<br/>SMS + in-app] --> B[Winner confirms identity<br/>Tier 2: liveness + next of kin on file]
    B --> C{Delivery or collection?}
    C -- Delivery --> D[Address captured,<br/>stock unit allocated, carrier booked]
    C -- Collection --> E[Collection point and slot chosen]
    D --> F[Handover: one-time code + photo]
    E --> F
    F --> G[Warranty registered,<br/>serial number recorded against winner]
    G --> H[Claim closed]
    A -. no response .-> R[Reminders at 7, 30, 60, 80 days]
    R -. 90 days .-> S[Next of kin may claim with documents,<br/>otherwise expired per published rules]
```

## 8. Refunds

```mermaid
flowchart TD
    A{What happened?} -->|Paid, no ticket issued| B[Automatic full refund]
    A -->|Charged twice| B
    A -->|Cycle voided| C[Refund every ticket price;<br/>instant wins already revealed stay honoured]
    A -->|Ineligible buyer:<br/>under 18, outside state,<br/>excluded, staff| D[Compliance requests → second person approves →<br/>ticket cancelled, price refunded, winnings void]
    A -->|Stolen card / dispute| E[Refund cardholder, cancel ticket,<br/>forfeit winnings, review account]
    A -->|Change of mind or losing ticket| F[No refund]
    B --> G[Back to original payment method only]
    C --> G
    D --> G
    E --> G
```

## 9. Daily reconciliation

```mermaid
flowchart LR
    A[Gateway settlement report] --> D{Match?}
    B[Ledger totals] --> D
    C[Bank / escrow statements] --> D
    D -- Yes --> E[Day signed off by Finance]
    D -- No --> F[Compliance alert;<br/>cycle cannot be archived until resolved]
```
