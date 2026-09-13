---
description: The contract records what must be delivered. It never records facts about the game.
paths: ["knowledge/contract.json", "**/knowledge/contract.json"]
---

# The contract owes deliveries, not findings

Every field here is a requirement: which slots apply, which regions must carry human
names, which documents must exist, what fraction of meaning-bearing nodes must be named.

It must not contain a fact about the title. At project start the save mechanism, the free
RAM and the runtime count are unknown; writing one here produces a finding nobody
established, carrying the authority of the contract. It has happened: an address range
from an earlier run was copied into a contract for a fresh project, one message after the
rule against it was stated.

State regions by **role** — `"loader"`, `"engine"` — never by address. The address is
resolved later, through the model boundary somebody asserted after reading.

`contract_show` returns the contract, or the kickoff questions where none is set. Every
kickoff question asks for a delivery. None of them asks what the game does.
