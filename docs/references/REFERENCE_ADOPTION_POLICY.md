# CompanyOS — External Reference Adoption Policy (permanent)

> Status: **RATIFIED** (Sprint 23, Boss superseding order §4). Permanent rule —
> applies to every future sprint. Companion inventory:
> `REFERENCE_CAPABILITY_MAP.md`.

## 1. The rule

External open-source projects are **REFERENCES, not implicit architecture
authorities**. Studying a project never imports its authority: every mechanism
taken from it must be translated into an explicit CompanyOS-native
specification BEFORE implementation.

For every external project used, CompanyOS records:

1. External mechanism (what the project does).
2. The CompanyOS problem it speaks to.
3. The CompanyOS canonical owner of that concern.
4. Adoption decision: **ADOPT / ADAPT / COMBINE / DEFER / REJECT**.
5. Implementation requirements (the CompanyOS-native spec).
6. Forbidden copy (what must never be imported).
7. Acceptance tests proving the translation.

A reference name without these seven fields is not an adoption record.

## 2. Authority invariants (permanent)

- External projects do not override frozen CompanyOS truth.
- One canonical concern has exactly ONE owner. A reference may inform an
  owner's design; it may never become a second owner.
- External mechanisms MAY be combined (mechanism A's durability with
  mechanism B's projection seam) — the combination is recorded as COMBINE.
- Duplicate Truth / DAG / Task / Scheduler / Authority is forbidden — from
  references exactly as from internal work (ARCH-005/006/010/012/029).
- The reference mechanism must be translated before implementation: no
  "参考 XXX 项目实现" without a native spec the implementer can build against.
- The implementer must never be expected to "infer what Boss meant": the
  translation is the contract.

## 3. Decision vocabulary

| Decision | Meaning |
|---|---|
| ADOPT | take the mechanism as-is into a CompanyOS-owned seam (still no dependency unless separately approved) |
| ADAPT | translate the mechanism into CompanyOS-native shape |
| COMBINE | blend mechanisms from several references behind one CompanyOS owner |
| DEFER | correct idea, wrong phase; recorded for the future with the trigger |
| REJECT | mechanism conflicts with frozen CompanyOS truth; forbidden copy recorded |

## 4. Review obligation

A new reference enters the map only with locally verified evidence (docs,
notes, or a Boss execution order). A name whose mechanism is not documented
locally is registered as `DETAILS_NOT_YET_VERIFIED` — never hallucinated.
