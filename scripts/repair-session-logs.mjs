// repair-session-logs.mjs — make DeepSeek Orb 0.1.7 Computer Use sessions loadable in DeepSeek Harness 0.2.
//
// Orb wrote a `computer-use/coordinate-mode` event into every overlay Computer Use session. Harness 0.2 dropped
// that type from its known-event list and refuses to load a log with an unknown event unless the event carries
// `"ignorable": true` (the envelope's compatibility marker). This script adds that marker to those events.
// The mode itself keeps working: dsh-orb reads it from the (now ignorable) event.
//
// usage: node scripts/repair-session-logs.mjs [--dry-run] [--dsh-home <dir>]
// Quit DeepSeek Harness first. Each changed log is backed up next to itself as <name>.orb-backup.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import zlib from "node:zlib";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const homeAt = args.indexOf("--dsh-home");
const dshHome = homeAt >= 0 ? args[homeAt + 1] : process.env.DSH_HOME || join(homedir(), ".dsh");
const TYPES = new Set(["computer-use/coordinate-mode"]);

if (!dryRun && process.platform === "win32") {
	const running = execFileSync("tasklist", ["/FI", "IMAGENAME eq DeepSeek Harness.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" });
	if (/DeepSeek Harness\.exe/i.test(running)) {
		console.error("DeepSeek Harness is running; quit it first (it keeps session logs open).");
		process.exit(1);
	}
}

/**
 * Split concatenated zstd frames by walking each frame header and block headers (RFC 8878 §3.1), so the exact
 * frame boundaries are known (DSH appends one frame per flush; Node's decoders stop after the first frame).
 */
function zstdFrames(buf) {
	const frames = [];
	let off = 0;
	while (off < buf.length) {
		const magic = buf.readUInt32LE(off);
		if ((magic & 0xfffffff0) === 0x184d2a50) {
			off += 8 + buf.readUInt32LE(off + 4); // skippable frame
			continue;
		}
		if (magic !== 0xfd2fb528) throw new Error(`not a zstd frame at byte ${off}`);
		let p = off + 4;
		const fhd = buf[p++];
		const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
		if (!single) p += 1;
		p += [0, 1, 2, 4][dictFlag];
		p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
		for (;;) {
			const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
			p += 3;
			const type = (header >> 1) & 3;
			p += type === 1 ? 1 : header >>> 3;
			if (header & 1) break;
		}
		if (checksum) p += 4;
		if (p > buf.length) throw new Error(`truncated zstd frame at byte ${off}`);
		frames.push(buf.subarray(off, p));
		off = p;
	}
	return frames;
}

async function decompress(file) {
	return zstdFrames(readFileSync(file)).map((frame) => zlib.zstdDecompressSync(frame).toString("utf8")).join("");
}

function* logs(dir) {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* logs(path);
		else if (/^session\.v\d+\.jsonl(\.zstd)?$/.test(entry.name)) yield path;
	}
}

/** Mark known-removed Orb event lines ignorable; returns [newText, changes]. */
function markIgnorable(text) {
	let changes = 0;
	const out = text.split("\n").map((line) => {
		if (line.trim() === "" || !line.includes("computer-use/")) return line;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return line;
		}
		if (!TYPES.has(event?.type) || event.ignorable === true) return line;
		changes++;
		return JSON.stringify({ ...event, ignorable: true });
	});
	return [out.join("\n"), changes];
}

let scanned = 0, changedFiles = 0, changedEvents = 0;
for (const file of logs(join(dshHome, "sessions"))) {
	scanned++;
	const zstd = file.endsWith(".zstd");
	let body, changes = 0;
	if (zstd) {
		// DSH writes the header as its own first frame and one frame per flush; keep that framing exactly and
		// recompress only the frames whose text changed.
		const original = readFileSync(file);
		const parts = zstdFrames(original).map((frame) => {
			const [text, n] = markIgnorable(zlib.zstdDecompressSync(frame).toString("utf8"));
			changes += n;
			return n === 0 ? frame : zlib.zstdCompressSync(Buffer.from(text, "utf8"));
		});
		body = Buffer.concat(parts);
	} else {
		const [text, n] = markIgnorable(readFileSync(file, "utf8"));
		changes = n;
		body = Buffer.from(text, "utf8");
	}
	if (changes === 0) continue;
	changedFiles++;
	changedEvents += changes;
	console.log(`${dryRun ? "would fix" : "fixing"} ${changes} event(s) in ${file}`);
	if (dryRun) continue;
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, body);
	// Verify before replacing: same frame count and the same text except for the marked events.
	if (zstd) {
		const before = zstdFrames(readFileSync(file)), after = zstdFrames(readFileSync(tmp));
		if (before.length !== after.length) throw new Error(`frame count changed for ${file}; original left untouched`);
		for (let i = 0; i < before.length; i++) {
			const want = markIgnorable(zlib.zstdDecompressSync(before[i]).toString("utf8"))[0];
			if (zlib.zstdDecompressSync(after[i]).toString("utf8") !== want) throw new Error(`verification failed for ${file}; original left untouched`);
		}
	}
	copyFileSync(file, `${file}.orb-backup`);
	renameSync(tmp, file);
}
console.log(`${scanned} log(s) scanned, ${changedEvents} event(s) in ${changedFiles} log(s) ${dryRun ? "need fixing" : "fixed"}.`);
