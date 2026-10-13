# Agent catalogue and registration

## Reviewed catalogue basis

`hro-agents-v1` reviews coordination associations against the canonical
`hro-operational-v1` outcome definitions and `hro-master-v1` source provenance.
The mappings preserve canonical keys, including the existing normalization of
mandatory learning assignment to `assign-learning`. A reviewed association
means that an agent role is relevant to coordinating that service; it is not
approval of an executor, outcome contract, professional decision or coverage
maturity. Supporting roles can overlap domain roles without taking authority.

Catalogue responsibilities, prerequisites and reviewed service associations
must change together with the catalogue version. Existing bindings to an older
version require explicit administrative review; they are not silently upgraded.

The twelve product families are browsing metadata, not a replacement for the
master taxonomy. Unassociated reference outcomes remain in the intent
catalogue. Custom outcomes remain explicitly review-required even when their
names resemble a canonical outcome. No fuzzy matching is performed.

## Current factual capability inventory

- Simulation personas retain their original identities and descriptions.
- A tenant principal is a durable nonhuman identity with an eligible accountable
  human owner. Catalogue binding is separate setup metadata.
- The invocation runtime implements only `tool.case.read`, returning case ID
  and lifecycle stage. Existing owner-only initiation, tenant/case scope and
  agent/initiator permission intersection are unchanged.
- No domain or supporting catalogue role has an execution adapter. Existing
  legacy workflow registry entries, provider routines, document checks and
  connector watchers do not establish an adapter for a bound role.
- Setup does not write grants, groups, assignments, case state, notifications,
  provider dispatch or model calls.

## Durable setup and explicit resolution

One client role binds to one exact principal, and one principal to one role.
Display names never select or reuse identities automatically. A matching name
is a conflict requiring an exact-ID binding or another name. Each mutation uses
the current catalogue version, binding generation and existing-principal
generation. A tenant advisory lock serializes setup with governance writers.

An explicit, acknowledged replacement can bind another active eligible
principal or reaffirm a reviewed active principal revision; the previous
principal and its permissions are untouched. Retired/revoked principals are
never restored. Ineligible ownership blocks setup without memberships or
promotions. Append-only setup receipts retain request identity through later
rebindings; superseded retries cannot restore historical bindings.

The selected client administrator is checked live inside the transaction.
Public Demo identities have no new administration rights. Verified private
administrator access can perform setup without promoting its membership, but
accountable ownership still requires an eligible active human client member.

## Deferred integration points

Future case-detail/Action Center ownership projections must read the binding as
presentation metadata only, not authorization. Conversational selection,
delegated dispatch, offline activation and capability bridges are deferred.
Any future adapter must independently check live owner/initiator access,
approved policy and evidence, privacy gates, executor availability and
effect-journal fences. Registration cannot substitute for any of those checks.
