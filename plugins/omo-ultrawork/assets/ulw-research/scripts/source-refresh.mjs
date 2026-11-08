// source-refresh.mjs - `source refresh <S<n>>`: the one explicit repin of a source snapshot.
//
// Static fetches may re-fetch meta.url; browser sources require a new actual --html/--raw capture.
// Moves the complete prior capture into .history before writing the new snapshot, then re-anchors
// active byte-located rows by exact quote and stored context (raw-locator.mjs): a match gets the new
// snapshot_sha256 and keeps its old locator, so `fact verify` then reports minor `relocated` with
// the old and new byte offsets; a row whose quote is gone keeps its old pin, is reported as
// quote_not_verbatim here, and stays a snapshot_hash_mismatch blocker until it is retracted or
// re-added. A legacy text.txt row on the source (no byte locator) cannot be re-anchored: it is
// listed as legacy_not_reanchored and stays a blocker. Exit 0 when every row re-anchored, 1 otherwise. node: builtins and sibling imports only.

import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { CliError, parseArgs } from "./cli-support.mjs"
import { DEFECT_CODES } from "./contracts.mjs"
import { readLedger, writeLedger } from "./fact-ledger.mjs"
import { reanchor } from "./raw-locator.mjs"
import { acquire, sessionDirOf, snapshotOf } from "./source-commands.mjs"
import { writeSnapshot } from "./source-snapshot.mjs"

export const REFRESH_USAGE =
	"usage: source refresh S<n> [--url <u> | --html <file> | --raw <file> [--text <file> --extractor NAME@VERSION] | --text <file> | --command '<argv json>' --cwd DIR] [--charset NAME] --session-dir D (only static fetches may refetch their url; browser sources require --html/--raw)"

const INPUTS = ["url", "html", "raw", "text", "command"]

const defect = (code, message) => ({ code, severity: DEFECT_CODES[code].severity, integrity: DEFECT_CODES[code].integrity, message })

export async function runRefresh(argv) {
	const args = parseArgs(argv)
	const id = args.positionals[0] ?? args.flags.id
	if (!id || id === true) throw new CliError(REFRESH_USAGE)
	const sessionDir = sessionDirOf(args.flags)
	const before = snapshotOf(sessionDir, id)
	const ledger = readLedger(sessionDir)
	const previousRows = ledger.rows.filter((row) => row.source_id === id).map((row) => structuredClone(row))
	const browser = before.meta.acquisition === "browser"
		|| before.meta.acquisition === undefined && before.meta.kind === "page" && before.meta.extractor !== "tool:source-snapshot@1"
	const flags = { ...args.flags }
	if (browser && (flags.url !== undefined || flags.html === undefined && flags.raw === undefined)) {
		throw new CliError(`${id} is browser-derived; refresh requires an actual --html or --raw capture, never a URL refetch`)
	}
	if (!INPUTS.some((name) => flags[name] !== undefined)) {
		if (!/^https?:\/\//i.test(String(before.meta.url))) throw new CliError(`${id} was not fetched from an http(s) url; pass its new capture. ${REFRESH_USAGE}`)
		flags.url = before.meta.url
	}
	const { receipt, ...input } = await acquire(flags)
	input.kind ??= flags.kind ?? before.meta.kind
	input.provenance = flags.provenance ?? before.meta.provenance
	input.revision = flags.revision ?? before.meta.revision ?? undefined
	if (browser) {
		input.acquisition = "browser"
		input.url = before.meta.url
	}
	let written
	try {
		written = writeSnapshot(join(sessionDir, "sources"), id, input, { replace: true })
	} catch (error) {
		if (error instanceof TypeError) throw new CliError(error.message)
		throw error
	}
	if (receipt) writeFileSync(join(written.dir, "command.json"), `${JSON.stringify(receipt, null, 2)}\n`)
	const after = snapshotOf(sessionDir, id)
	const rows = []
	const defects = []
	for (const row of ledger.rows) {
		if (row.source_id !== id || row.status !== "active") continue
		if (row.locator?.unit === undefined) {
			rows.push({ fact_id: row.fact_id, status: "legacy_not_reanchored" })
			defects.push(defect("snapshot_hash_mismatch", `${row.fact_id}: a legacy text.txt row has no byte locator to re-anchor on refreshed ${id}; add it again from the new snapshot or retract it`))
			continue
		}
		if (row.locator.unit !== "bytes") continue
		const anchor = row.locator.artifact === after.view.artifact ? reanchor(after.view, row) : null
		const span = `${row.locator.char_start}:${row.locator.char_end}`
		if (!anchor) {
			rows.push({ fact_id: row.fact_id, status: "not_found", from: span })
			defects.push(defect("quote_not_verbatim", `${row.fact_id}: its quote and context are not found once in refreshed ${id}; retract it or add it again from the new snapshot`))
			continue
		}
		row.snapshot_sha256 = after.sha256
		rows.push({ fact_id: row.fact_id, status: anchor.relocated ? "relocated" : "unchanged", from: span, to: `${anchor.start}:${anchor.end}` })
		if (anchor.relocated) defects.push(defect("relocated", `${row.fact_id}: ${span} -> ${anchor.start}:${anchor.end} (bytes of ${id}/${after.view.artifact})`))
	}
	writeLedger(sessionDir, ledger)
	const failed = rows.filter((row) => row.status === "not_found" || row.status === "legacy_not_reanchored").length
	const exitCode = failed > 0 ? 1 : 0
	const data = { source_id: id, previous_sha256: before.sha256, previous_capture: written.previousDirectory, snapshot_sha256: after.sha256, text_source: after.view.mode, rows }
	writeFileSync(join(written.dir, "refresh.json"), `${JSON.stringify({ ...data, previous_rows: previousRows, rebound_rows: ledger.rows.filter((row) => rows.some((result) => result.fact_id === row.fact_id && ["relocated", "unchanged"].includes(result.status))) }, null, 2)}\n`)
	const json = { command: "source refresh", status: exitCode === 0 ? "pass" : "fail", exitCode, defects, data }
	const moved = rows.filter((row) => row.status === "relocated").length
	return { json, summary: `source refresh: ${id} ${before.sha256.slice(0, 12)} -> ${after.sha256.slice(0, 12)}; ${rows.length - failed} row(s) re-anchored (${moved} relocated), ${failed} not re-anchored`, exitCode }
}
