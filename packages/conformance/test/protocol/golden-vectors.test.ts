/**
 * Proves the golden vectors in `src/protocol/**` actually match what
 * `@browserglass/protocol` encodes and decodes today: this is what keeps
 * the vectors honest as the protocol evolves, rather than a snapshot that
 * quietly drifts the moment someone changes a field and forgets the
 * fixture. Three things are checked, one per vector kind:
 *
 *   1. Every {@link BINARY_FRAME_VECTORS} entry decodes, byte for byte,
 *      to its declared `decoded` fields via the real
 *      `decodeBinaryHeader`, and re-encodes back to the identical bytes
 *      via the real `encodeBinaryHeader`.
 *   2. Every {@link MALFORMED_BINARY_FRAME_VECTORS} entry throws
 *      `ProtocolError` from the real `decodeBinaryHeader`.
 *   3. Every {@link MESSAGE_VECTORS} entry validates against the
 *      generated `wire-messages.schema.json`, using `ajv`: the schema is
 *      itself generated from `@browserglass/protocol`'s own TypeScript
 *      source (see `scripts/generate-wire-schema.mjs`), so this closes
 *      the loop between the hand-written example object, the real
 *      TypeScript type (already checked at compile time by
 *      `message-vectors.ts`'s own `satisfies` clauses), and the
 *      generated schema a foreign implementation would actually validate
 *      against.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ProtocolError, decodeBinaryHeader, encodeBinaryHeader } from '@browserglass/protocol';
import { decodeUploadChunkPayload } from '@browserglass/protocol';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  BINARY_FRAME_VECTORS,
  MALFORMED_BINARY_FRAME_VECTORS,
  UPLOAD_CHUNK_PAYLOAD_VECTORS,
} from '../../src/protocol/binary-vectors.js';
import { MESSAGE_VECTORS } from '../../src/protocol/message-vectors.js';

function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.trim();
  const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const bytes = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) bytes[i] = Number.parseInt(parts[i] as string, 16);
  return bytes;
}

describe('binary frame vectors decode to their declared fields', () => {
  for (const vector of BINARY_FRAME_VECTORS) {
    it(vector.name, () => {
      const headerBytes = hexToBytes(vector.hex);
      const payloadBytes = vector.payloadHex ? hexToBytes(vector.payloadHex) : new Uint8Array(0);
      const full = new Uint8Array(headerBytes.byteLength + payloadBytes.byteLength);
      full.set(headerBytes, 0);
      full.set(payloadBytes, headerBytes.byteLength);

      const decoded = decodeBinaryHeader(full);
      expect(decoded.version).toBe(vector.decoded.version);
      expect(decoded.msgType).toBe(vector.decoded.msgType);
      expect(decoded.streamId).toBe(vector.decoded.streamId);
      expect(decoded.seq).toBe(vector.decoded.seq);
      expect(decoded.tsDeltaMs).toBe(vector.decoded.tsDeltaMs);
      expect(decoded.payloadCodec).toBe(vector.decoded.payloadCodec);
      expect(decoded.flags).toBe(vector.decoded.flags);
      expect(decoded.gen16).toBe(vector.decoded.gen16);
      expect(decoded.keyframe).toBe(vector.decoded.keyframe);
      expect(decoded.thumbnail).toBe(vector.decoded.thumbnail);
      expect(decoded.partial).toBe(vector.decoded.partial);
      expect(decoded.final).toBe(vector.decoded.final);
      expect(decoded.synthetic).toBe(vector.decoded.synthetic);
      expect(decoded.dprScaled).toBe(vector.decoded.dprScaled);
      expect(decoded.alpha).toBe(vector.decoded.alpha);
      expect(decoded.ext).toBe(vector.decoded.ext);
      expect(decoded.payload.byteLength).toBe(payloadBytes.byteLength);

      // Re-encoding the decoded header fields must reproduce the exact
      // 20 header bytes this vector started from: the round trip a
      // foreign implementation's own encoder should be checked against.
      const reencoded = encodeBinaryHeader({
        version: decoded.version,
        msgType: decoded.msgType,
        streamId: decoded.streamId,
        seq: decoded.seq,
        tsDeltaMs: decoded.tsDeltaMs,
        payloadCodec: decoded.payloadCodec,
        flags: decoded.flags,
        gen16: decoded.gen16,
      });
      expect(Array.from(reencoded)).toEqual(Array.from(headerBytes));
    });
  }
});

describe('malformed binary frame vectors are rejected', () => {
  for (const vector of MALFORMED_BINARY_FRAME_VECTORS) {
    it(`${vector.name} (${vector.reason})`, () => {
      const bytes = hexToBytes(vector.hex);
      expect(() => decodeBinaryHeader(bytes)).toThrow(ProtocolError);
    });
  }
});

describe('UPLOAD_CHUNK payload vectors split back into the declared uploadId and chunk', () => {
  for (const vector of UPLOAD_CHUNK_PAYLOAD_VECTORS) {
    it(vector.name, () => {
      const payload = hexToBytes(vector.payloadHex);
      const { uploadId, chunk } = decodeUploadChunkPayload(payload);
      expect(Buffer.from(uploadId).toString('hex').toUpperCase()).toBe(
        hexToBytes(vector.uploadIdHex).reduce(
          (s, b) => s + b.toString(16).padStart(2, '0').toUpperCase(),
          '',
        ),
      );
      expect(Buffer.from(chunk).toString('hex').toUpperCase()).toBe(
        hexToBytes(vector.chunkHex).reduce(
          (s, b) => s + b.toString(16).padStart(2, '0').toUpperCase(),
          '',
        ),
      );
    });
  }
});

/**
 * The generated schema, loaded once for every message vector test below.
 * Loaded from disk (not imported as a module) so this test exercises the
 * exact committed artifact a foreign implementation would fetch, not a
 * bundler's in-memory copy of it.
 */
const schemaPath = fileURLToPath(
  new URL('../../src/protocol/schema/wire-messages.schema.json', import.meta.url),
);
const wireSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  definitions: Record<string, unknown>;
};

/**
 * `Ajv2020` (draft 2020-12) reads a draft-07 document like this schema's
 * `$schema` declares without complaint: draft-07's own keyword set is a
 * subset of 2020-12's, and this schema uses none of the keywords that
 * changed meaning between the two (no `items`-as-tuple, no
 * `additionalItems`). `strict: false` because `ts-json-schema-generator`
 * emits an untyped `additionalProperties: { description: ... }` for
 * `Envelope`'s index signature (see `binary-vectors.ts`'s sibling doc on
 * this same pattern for `error.context`), which ajv's strict mode flags as
 * an unrecognised property-schema shape even though it is valid JSON
 * Schema.
 */
const ajv = new Ajv2020.default({ strict: false, allErrors: true });
// Every message interface is a top-level entry under `definitions`; there
// is no single root schema to compile once, so each vector below compiles
// (and ajv caches) its own named definition against the shared schema
// document via `$ref`.
for (const [name, def] of Object.entries(wireSchema.definitions)) {
  ajv.addSchema(def as object, `#/definitions/${name}`);
}

/** Maps a message's `t` value to the TypeScript interface name the schema was generated under (see `message-vectors.ts`'s import list for the same mapping in reverse). */
const SCHEMA_NAME_BY_T: Readonly<Record<string, string>> = {
  hello: 'Hello',
  welcome: 'Welcome',
  ping: 'Ping',
  pong: 'Pong',
  resume: 'Resume',
  resumed: 'Resumed',
  goodbye: 'Goodbye',
  'session.busy': 'SessionBusy',
  'capabilities.updated': 'CapabilitiesUpdated',
  'target.list': 'TargetList',
  'target.listed': 'TargetListed',
  'target.created': 'TargetCreated',
  'target.updated': 'TargetUpdated',
  'target.closed': 'TargetClosed',
  'target.activate': 'TargetActivate',
  'target.new': 'TargetNew',
  'target.close': 'TargetClose',
  'target.reorder': 'TargetReorder',
  'stream.subscribe': 'StreamSubscribe',
  'stream.subscribed': 'StreamSubscribed',
  'stream.unsubscribe': 'StreamUnsubscribe',
  'stream.pause': 'StreamPause',
  'stream.resume': 'StreamResume',
  'stream.quality': 'StreamQuality',
  'stream.stats': 'StreamStats',
  'stream.degraded': 'StreamDegraded',
  ack: 'Ack',
  'keyframe.request': 'KeyframeRequest',
  'input.mouse': 'InputMouse',
  'input.key': 'InputKey',
  'input.text': 'InputText',
  'input.touch': 'InputTouch',
  'input.composition': 'InputComposition',
  'input.drag': 'InputDrag',
  'control.request': 'ControlRequest',
  'control.granted': 'ControlGranted',
  'control.denied': 'ControlDenied',
  'control.queued': 'ControlQueued',
  'control.renew': 'ControlRenew',
  'control.release': 'ControlRelease',
  'control.revoked': 'ControlRevoked',
  'control.revoke': 'ControlRevoke',
  'control.expiring': 'ControlExpiring',
  'control.preempt.request': 'ControlPreemptRequest',
  'control.preempt.cancelled': 'ControlPreemptCancelled',
  'control.preempted': 'ControlPreempted',
  'control.state': 'ControlStateMsg',
  'control.contention': 'ControlContention',
  'nav.goto': 'NavGoto',
  'nav.back': 'NavBack',
  'nav.forward': 'NavForward',
  'nav.reload': 'NavReload',
  'nav.stop': 'NavStop',
  'nav.state': 'NavState',
  'clipboard.read': 'ClipboardRead',
  'clipboard.write': 'ClipboardWrite',
  'clipboard.data': 'ClipboardData',
  'upload.begin': 'UploadBegin',
  'upload.accepted': 'UploadAccepted',
  'upload.progress': 'UploadProgress',
  'upload.complete': 'UploadComplete',
  'upload.done': 'UploadDone',
  'filechooser.opened': 'FileChooserOpened',
  'filechooser.answer': 'FileChooserAnswer',
  'download.started': 'DownloadStarted',
  'download.progress': 'DownloadProgress',
  'download.ready': 'DownloadReady',
  'download.failed': 'DownloadFailed',
  'dialog.opened': 'DialogOpened',
  'dialog.answer': 'DialogAnswer',
  'dialog.closed': 'DialogClosed',
  'instance.state': 'InstanceStateMsg',
  'instance.recovering': 'InstanceRecovering',
  'instance.recovered': 'InstanceRecovered',
  'instance.restart': 'InstanceRestart',
  'instance.released': 'InstanceReleased',
  'instance.relocate': 'InstanceRelocate',
  'presence.state': 'PresenceState',
  'presence.cursor': 'PresenceCursor',
  'presence.viewport': 'PresenceViewport',
  'console.entry': 'ConsoleEntry',
  'page.error': 'PageError',
  'network.summary': 'NetworkSummary',
  'devtools.open': 'DevtoolsOpen',
  'devtools.url': 'DevtoolsUrl',
  'diagnostics.subscribe': 'DiagnosticsSubscribe',
  'diagnostics.unsubscribe': 'DiagnosticsUnsubscribe',
  'diagnostics.subscribed': 'DiagnosticsSubscribed',
  'diagnostics.status.get': 'DiagnosticsStatusGet',
  'diagnostics.status.got': 'DiagnosticsStatusGot',
  'network.request': 'NetworkRequestEntry',
  'target.capture': 'TargetCapture',
  'target.captured': 'TargetCaptured',
  'target.probe': 'TargetProbe',
  'target.probed': 'TargetProbed',
  error: 'ErrorMsg',
};

describe('message vectors validate against the generated JSON Schema', () => {
  it('SCHEMA_NAME_BY_T covers every message vector, and vice versa (no orphan on either side)', () => {
    const vectorTs = new Set(MESSAGE_VECTORS.map((v) => v.t));
    const mappedTs = new Set(Object.keys(SCHEMA_NAME_BY_T));
    expect([...vectorTs].sort()).toEqual([...mappedTs].sort());
  });

  for (const vector of MESSAGE_VECTORS) {
    it(`${vector.t} (${vector.sourceFile})`, () => {
      const schemaName = SCHEMA_NAME_BY_T[vector.t];
      expect(schemaName, `no schema name mapped for t="${vector.t}"`).toBeDefined();
      expect(
        wireSchema.definitions[schemaName as string],
        `schema has no definition named "${schemaName}"`,
      ).toBeDefined();

      const validate =
        ajv.getSchema(`#/definitions/${schemaName}`) ??
        ajv.compile(wireSchema.definitions[schemaName as string] as object);
      const valid = validate(vector.envelope);
      if (!valid) {
        throw new Error(
          `${vector.t} failed schema validation: ${JSON.stringify(validate.errors, null, 2)}`,
        );
      }
      expect(valid).toBe(true);
    });
  }
});
