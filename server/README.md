# Local incident server

From the repository root, run `npm run seed`, then `npm run start`.
The server prints its actual URL, normally `http://127.0.0.1:3000`.
Set `PORT` to another port, or `PORT=0` for an available ephemeral port.
Press Ctrl+C to close it gracefully. Run `npm test` for verification.

The server reads `.runtime/incidents.json` without changing it and serves
the repository's `public/` directory when frontend files are present.
Only GET requests are supported. API errors are `{error:{code,message}}`.

`/api/incidents` accepts literal case-insensitive `q` over ID, title and
description; repeated `service`, `status` and `severity`; inclusive UTC
`from` and `to` dates in YYYY-MM-DD form; `sort=openedAt|severity`;
`direction=asc|desc`; a positive `page`; and `pageSize=25|50`.
Defaults are no filters, openedAt descending, page 1 and size 25.
Facet values are case-sensitive and use the dataset's exact enumerations.
Values within a facet are OR, and separate facets are AND.
Opened-date ties use ID ascending. Severity ties use openedAt descending,
then ID ascending. Page requests clamp to the available range.
Summaries cover all matches, with chronological UTC day buckets.

`/api/overview` accepts the same parameters and validation as
`/api/incidents`. Valid sort, direction, page and pageSize values do not
affect its measures: every matching incident contributes, including those
beyond the visible page. It returns `{services:[{service,incidentCount,
unresolvedCount,highSeverityCount,averageResolutionHours}]}`.
Only matching services appear, ordered by unresolved count descending,
then service name ascending. Unresolved means open or in progress; high
severity means critical or high. Average resolution hours is the mean of
`(resolvedAt - openedAt) / 3600000` for resolved incidents only, or `null`
when there are none. An empty result returns `{services:[]}`.

`/api/incidents/:id` returns every incident field, or 404.
`/api/export.csv` applies the same filters and sorting, ignores pagination,
and exports all fields in dataset order. Tags are JSON array text, null is
empty, quotes are doubled, and records use CRLF.
