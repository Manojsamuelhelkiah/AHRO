# Offline email-editor compatibility corpus

These small, hand-authored structures represent common editor conventions, not
captured customer messages or exhaustive vendor/version certification. Names are
fictional, and every mailbox and remote URL uses the reserved `.invalid` domain.
The corpus is separate from the reported 19-column regression fixture and pins
its own labels and expected facts so registry changes cannot silently rewrite it.

Each of Gmail, Outlook and Apple Mail has these cases:

| Case suffix | Expectation | Required behavior |
| --- | --- | --- |
| wrapped | Supported suggestion | Map one 19-column table exactly, decoding entities, span wrappers and mailto display text. |
| quoted-template | Review required | Current plus quoted/forwarded template is ambiguous; retain no employee fields, including quoted-only optional facts. |
| unrelated-quote | Review required | Unknown quoted table produces a visible issue; retain only the exact current-table facts. |
| multiple-employees | Review required | Do not merge employee rows or select the first employee. |
| layout-table | Review required | Nested layout tables are malformed for intake; do not infer their layout. |

Gmail cases use `dir=ltr`, `gmail_default`, `gmail_quote` and `gmail_attr`.
Outlook cases use Office namespaces, `WordSection1`, `MsoNormal`, `o:p` and
`divRplyFwdMsg`. Apple Mail cases use `AppleOriginalContents`,
`Apple-interchange-newline` and `blockquote type=cite`.

Additional tests exercise equivalent `multipart/alternative` bodies in both
orders, conflicting alternatives in both orders, merged Outlook cells, attached
forwarded `message/rfc822`, and inert image/style/script/iframe resources.
“Supported” means deterministic suggestions only: human review is still required.
Unsupported layouts must remain visible extraction issues, not silent imports.
This does not add quote stripping or any new inference to the parser.

Run from the repository root:

```sh
pnpm --filter @workspace/api-server run test:email-editors
```

The standalone runner bundles only the pure MIME decoder, streaming tokenizer,
registry, template validator and fixtures. It rejects unexpected application or
third-party imports, passes no credentials or database configuration to the test
child, runs extraction inside the provider-denial scope, and denies network transports in the
child. No provider, model, browser/HTML renderer, database, attachment loading or
remote-resource fetching participates. The regular API test command includes it.
