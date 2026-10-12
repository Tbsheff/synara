const INDEX_SIGNATURE = 0x44495243;
const INDEX_HEADER_BYTES = 12;
const ENTRY_STAT_BYTES = 40;
const ENTRY_FLAGS_BYTES = 2;
const EXTENDED_FLAGS_BYTES = 2;
const FLAG_ASSUME_VALID = 0x8000;
const FLAG_EXTENDED = 0x4000;
const NAME_LENGTH_MASK = 0x0fff;
const OBJECT_ID_LENGTHS = [20, 32] as const;
const EXTENSION_HEADER_BYTES = 8;
const SPLIT_INDEX_EXTENSION = "link";

interface EntryScan {
  readonly assumeValid: boolean;
  readonly nextOffset: number;
}

function readVarint(
  bytes: Uint8Array,
  offset: number,
): { value: number; nextOffset: number } | null {
  let cursor = offset;
  let byte = bytes[cursor++];
  if (byte === undefined) return null;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = bytes[cursor++];
    if (byte === undefined) return null;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { value, nextOffset: cursor };
}

function scanEntry(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  version: number,
  objectIdLength: number,
): EntryScan | null {
  const flagsOffset = offset + ENTRY_STAT_BYTES + objectIdLength;
  if (flagsOffset + ENTRY_FLAGS_BYTES > bytes.length) return null;
  const flags = view.getUint16(flagsOffset);
  const extended = (flags & FLAG_EXTENDED) !== 0;
  if (extended && version < 3) return null;
  const nameOffset = flagsOffset + ENTRY_FLAGS_BYTES + (extended ? EXTENDED_FLAGS_BYTES : 0);
  const assumeValid = (flags & FLAG_ASSUME_VALID) !== 0;

  if (version === 4) {
    const prefix = readVarint(bytes, nameOffset);
    if (prefix === null) return null;
    const terminator = bytes.indexOf(0, prefix.nextOffset);
    return terminator < 0 ? null : { assumeValid, nextOffset: terminator + 1 };
  }

  const nameLength = flags & NAME_LENGTH_MASK;
  const terminator =
    nameLength < NAME_LENGTH_MASK ? nameOffset + nameLength : bytes.indexOf(0, nameOffset);
  if (terminator < 0 || bytes[terminator] !== 0) return null;
  const entryLength = (terminator - offset + 8) & ~7;
  return { assumeValid, nextOffset: offset + entryLength };
}

function scanEntries(
  bytes: Uint8Array,
  objectIdLength: number,
): { readonly hasAssumeValid: boolean } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4);
  const entryCount = view.getUint32(8);
  let offset = INDEX_HEADER_BYTES;
  let hasAssumeValid = false;
  for (let entry = 0; entry < entryCount; entry += 1) {
    const scan = scanEntry(bytes, view, offset, version, objectIdLength);
    if (scan === null) return null;
    hasAssumeValid ||= scan.assumeValid;
    offset = scan.nextOffset;
  }
  return extensionsAreComplete(bytes, view, offset, objectIdLength) ? { hasAssumeValid } : null;
}

function extensionsAreComplete(
  bytes: Uint8Array,
  view: DataView,
  firstExtensionOffset: number,
  objectIdLength: number,
): boolean {
  const checksumOffset = bytes.length - objectIdLength;
  let offset = firstExtensionOffset;
  while (offset + EXTENSION_HEADER_BYTES <= checksumOffset) {
    const signature = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    if (signature === SPLIT_INDEX_EXTENSION) return false;
    offset += EXTENSION_HEADER_BYTES + view.getUint32(offset + 4);
  }
  return offset === checksumOffset;
}

export function gitIndexHasAssumeUnchangedEntries(bytes: Uint8Array): boolean | null {
  if (bytes.length < INDEX_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4);
  if (view.getUint32(0) !== INDEX_SIGNATURE || version < 2 || version > 4) return null;
  for (const objectIdLength of OBJECT_ID_LENGTHS) {
    const result = scanEntries(bytes, objectIdLength);
    if (result !== null) return result.hasAssumeValid;
  }
  return null;
}
