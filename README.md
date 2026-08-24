# Arms Raised in a V

An evolving digital-garden vault, published from Obsidian.

## Mastodon toot sync

`scripts/sync-mastodon-toots.mjs` pulls all public toots for a Mastodon
account and writes each one as an individual Markdown note under
`Mastodon/`, ready to browse and link from Obsidian and to publish through
the site build.

Each note is idempotent by toot ID: rerunning the script only adds notes
for toots it hasn't seen yet, named `Mastodon/<date>-<toot-id>.md`, with
frontmatter (`title`, `date`, `mastodon_id`, `url`, `tags`, `visibility`).

### Run it manually

```sh
MASTODON_INSTANCE=mastodon.social MASTODON_USERNAME=yourname \
  npm run sync-toots
```

Only the unauthenticated public API is used, so this only ever pulls what
is already visible on the public profile — no access token required.

Optional env vars:

- `MASTODON_OUT_DIR` — output folder (default `Mastodon`)
- `MASTODON_EXCLUDE_REPLIES` — `"true"` to skip replies (default `"false"`)
- `MASTODON_EXCLUDE_REBLOGS` — `"true"` to skip boosts (default `"true"`)

### Automated daily sync

`.github/workflows/sync-mastodon-toots.yml` runs the same script on a
schedule and commits any new notes. To enable it, set two repository
variables under **Settings → Secrets and variables → Actions → Variables**:

- `MASTODON_INSTANCE`
- `MASTODON_USERNAME`

You can also trigger it on demand from the **Actions** tab
(`Sync Mastodon Toots` → *Run workflow*).
