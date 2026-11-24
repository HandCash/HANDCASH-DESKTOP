---
name: item-send-custody-row
when: optimizing collectable sends or cached inventory
---
BRC-150 lineage and cached cards are not custody metadata: read the exact held tip row before single or bulk send to reconstruct its BRC-29 key from customInstructions.
Never replace missing remittance with a root-key guess or bypass holding/script checks; do not scan whole baskets for selected tips.
