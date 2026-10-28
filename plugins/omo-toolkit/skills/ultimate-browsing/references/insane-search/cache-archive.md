> **Modified-port notice and license.** This prompt is a modified OMP port of oh-my-openagent material at revision `8a8db1d3094da8743989bf693ee5de77889de50e`. It is licensed under the Sustainable Use License 1.0 in `../../../../LICENSE-SUL-1.0`, which permits internal business use and personal/noncommercial use and permits free distribution for noncommercial purposes.

# Existing archive snapshots and provenance

An archive is a dated copy, not a way to assert current state. Use an existing public snapshot for a dead/changed source, a historical question, or explicitly qualified background. Do not substitute it for a required live account/price/status check. These are lookup recipes, not current availability promises; record the date of your own retrieval.

## Wayback Machine

1. Keep the original public URL. Do not submit a private URL, signed token or account-only resource to an archive.
2. Percent-encode it as one query value and use native `read` on `https://archive.org/wayback/available?url=<encoded-original-url>`. For a historical target add `&timestamp=YYYYMMDD`; the returned nearest capture can be before **or after** that target.
3. Inspect `archived_snapshots.closest`: require `available`, a successful status, `url` and `timestamp`. An absent/empty closest result means no usable capture was returned, not a blank original article.
4. Open the returned snapshot URL through `read`, or native browser if rendering is necessary. Validate both the original item identity and the actual captured body. Redirects, the archive toolbar alone, missing assets and an archived denial/login page do not prove content access.
5. Preserve the archive-provided timestamp (Wayback's 14-digit `YYYYMMDDhhmmss` capture time is UTC), exact snapshot URL, original URL and retrieval time. Check the **final** replay URL for a redirected capture/date. If dates disagree, resolve them before making a dated claim.

Do not fabricate a replay URL by inserting today's timestamp. The API result identifies a candidate, not proof that replay works. A source's publication/update date is separate from the archive capture date. For “as of” requests, explain any gap between the requested date and the actual capture; a later capture cannot establish earlier state without additional evidence.

## archive.today / archive.ph

Use an already-known snapshot URL first. Otherwise inspect the archive's existing-capture lookup, for example `https://archive.today/newest/<original-public-url>`, with `read` or the native browser. Follow only legitimate redirects from that lookup and record the final stable snapshot URL. A `/newest/` locator is not a stable citation.

Read the archive's displayed capture date and original URL. Preserve the displayed timezone; if none is given, say “timezone unspecified” rather than inventing UTC. Do not mistake the article's own publication date or your retrieval time for the capture time. If the date cannot be established, report an undated archive copy and do not use it as proof of a specific historical date.

A CAPTCHA, 429, submission form, archive landing page or empty replay is not a snapshot. Stop on rate limiting or an unchanged challenge; do not cycle aliases to defeat it. Looking up existing captures does not authorize clicking “save” or submitting a new capture, which can publish the URL/content to a third party.

## Citation and coverage

Keep separate evidence records when combining live and archived sources:

```text
Provenance: snapshot (Wayback / archive.today)
Original: https://source.example/article
Snapshot: exact stable URL returned and actually opened
Captured: archive-provided date/time + timezone (or explicitly unknown)
Retrieved: current UTC date/time
Coverage: captured body / partial body / metadata only
Caveats: missing media, inaccessible comments, capture gap, redirects, etc.
```

In the answer write “The snapshot captured on <date> says …” and link the snapshot plus original, rather than citing the original as if it had just been read live. Archived comments/counters may differ from live values; replayed resources can have different capture dates. Keep those limits beside the affected claim. Do not send credentials to archives or proxies, and do not describe an archive as permission to bypass access restrictions.
