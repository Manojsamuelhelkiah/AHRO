import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DirectoryWarning, IdentityDetails, identityLabel } from "./member-identity";

test("duplicate names and email labels remain distinguishable without full technical IDs", () => {
  const peers = [
    { clerkUserId: "user_long_one_abcdefgh", name: "Alex", email: "alex1@example.test" },
    { clerkUserId: "user_long_two_abcdefgh", name: "Alex", email: "alex2@example.test" },
    { clerkUserId: "user_long_three_abcdefgh", name: "Alex" },
    { clerkUserId: "user_long_four_abcdefgh", name: "Alex" },
  ];
  assert.match(identityLabel(peers[0], peers), /Alex · alex1@example.test/);
  assert.equal(new Set(peers.map((peer) => identityLabel(peer, peers))).size, peers.length);
  assert.ok(peers.every((peer) => !identityLabel(peer, peers).includes(peer.clerkUserId)));
  const duplicates = peers.slice(0, 2).map((peer) => ({ ...peer, email: "same@example.test" }));
  assert.notEqual(identityLabel(duplicates[0], duplicates), identityLabel(duplicates[1], duplicates));
});

test("honest unresolved and outage labels, accessible IDs and directory retry", () => {
  const member = { clerkUserId: "user_real_123456789", identityResolution: "missing" as const, accountKind: "human" as const };
  assert.match(identityLabel(member), /Unresolved account/);
  const markup = renderToStaticMarkup(<IdentityDetails member={member} />);
  assert.match(markup, /<summary[^>]*>Technical account ID/);
  assert.match(markup, /user_real_123456789/);
  assert.match(markup, /No directory profile found/);
  assert.equal(renderToStaticMarkup(<DirectoryWarning members={[member]} retry={() => {}} />), "");
  const unavailable = { ...member, identityResolution: "unavailable" as const };
  assert.match(identityLabel(unavailable), /Directory unavailable/);
  assert.match(renderToStaticMarkup(<DirectoryWarning members={[unavailable]} retry={() => {}} />), /Retry directory lookup/);
  assert.match(identityLabel({ ...member, accountKind: "internal" }), /Internal\/test account/);
});
