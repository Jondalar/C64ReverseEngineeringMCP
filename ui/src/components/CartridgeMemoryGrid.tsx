import { useState } from "react";
import type { CartridgeBankView, CartridgeChipView, CartridgeEmptyRegion, CartridgeLutChunk, CartridgeSegment, CartridgeSlotLayout, CartridgeStartupInfo } from "../types.js";

interface ChipClickHandler {
  (chip: CartridgeChipView, role: "ROML" | "ROMH" | "EEPROM"): void;
}

interface BankClickHandler {
  (bank: CartridgeBankView): void;
}

interface CartridgeMemoryGridProps {
  cartridgeName: string;
  hardwareType?: number;
  exrom?: number;
  game?: number;
  chips: CartridgeChipView[];
  banks: CartridgeBankView[];
  slotLayout?: CartridgeSlotLayout;
  lutChunks?: CartridgeLutChunk[];
  emptyRegions?: CartridgeEmptyRegion[];
  segments?: CartridgeSegment[];
  startup?: CartridgeStartupInfo;
  onSelectChip?: ChipClickHandler;
  onSelectBank?: BankClickHandler;
  onOpenChipHex?: ChipClickHandler;
  onOpenEepromHex?: () => void;
  onSelectLutChunk?: (chunk: CartridgeLutChunk) => void;
  onSelectSegment?: (segment: CartridgeSegment) => void;
  onOpenBankHex?: (bank: CartridgeBankView, chip: CartridgeChipView | undefined) => void;
}

function formatHexWord(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(4, "0")}`;
}

function formatHexByte(value: number): string {
  return `$${value.toString(16).toUpperCase().padStart(2, "0")}`;
}

function bytesPretty(bytes: number): string {
  if (bytes >= 0x100000) return `${(bytes / 0x100000).toFixed(2)} MiB`;
  if (bytes >= 0x400) return `${(bytes / 0x400).toFixed(1)} KiB`;
  return `${bytes} B`;
}

const ROML_COLOR = "#7ee787";
const ROMH_COLOR = "#f0883e";
const EMPTY_COLOR = "#1a1d21";

export function CartridgeMemoryGrid({
  cartridgeName,
  hardwareType,
  exrom,
  game,
  chips,
  banks,
  slotLayout,
  lutChunks,
  emptyRegions,
  segments,
  startup,
  onSelectChip,
  onSelectBank,
  onOpenChipHex,
  onOpenEepromHex,
  onSelectLutChunk,
  onSelectSegment,
  onOpenBankHex,
}: CartridgeMemoryGridProps) {
  // "all" = no filter; otherwise show only chunks where this LUT appears
  // in their refs[]. Empty string also means all so the chip-only view
  // (no LUT data at all) keeps working.
  const [activeLut, setActiveLut] = useState<string>("all");
  const bankSize = slotLayout?.bankSize ?? 0x2000;
  const hasRomh = slotLayout?.hasRomh ?? chips.some((chip) => chip.slot === "ROMH" || chip.slot === "ULTIMAX_ROMH");
  const hasEeprom = slotLayout?.hasEeprom ?? false;
  const isUltimax = slotLayout?.isUltimax ?? (exrom === 1 && game === 0);
  const hardwareTypeName = slotLayout?.hardwareTypeName ?? (hardwareType !== undefined ? `Type ${hardwareType}` : undefined);

  // Build LUT-pill list from all known refs across the chunks. We sort
  // alphabetically + always keep "all" as the first entry.
  const lutPillCounts = new Map<string, number>();
  for (const chunk of lutChunks ?? []) {
    const refs = chunk.refs?.length ? chunk.refs : [{ lut: chunk.lut, index: chunk.index, destAddress: chunk.destAddress }];
    for (const ref of refs) {
      lutPillCounts.set(ref.lut, (lutPillCounts.get(ref.lut) ?? 0) + 1);
    }
  }
  const lutPills = Array.from(lutPillCounts.entries()).sort(([a], [b]) => a.localeCompare(b));

  function chunkMatchesActiveLut(chunk: CartridgeLutChunk): boolean {
    if (activeLut === "all") return true;
    const refs = chunk.refs?.length ? chunk.refs : [{ lut: chunk.lut, index: chunk.index, destAddress: chunk.destAddress }];
    return refs.some((ref) => ref.lut === activeLut);
  }
  const visibleChunks = (lutChunks ?? []).filter(chunkMatchesActiveLut);

  // Empty (=$FF and not LUT-covered) regions per bank+slot — rendered
  // underneath the LUT chunks as a dark-grey "free to program" overlay.
  const emptyIndex = new Map<string, CartridgeEmptyRegion[]>();
  for (const region of emptyRegions ?? []) {
    const key = `${region.bank}:${region.slot === "ROML" ? "ROML" : "ROMH"}`;
    const bucket = emptyIndex.get(key);
    if (bucket) bucket.push(region);
    else emptyIndex.set(key, [region]);
  }

  // Resident segments (CBM80 startup, EAPI, anything not addressed via
  // LUT but also not erased flash). Painted between the empty layer and
  // the LUT chunks so they show up clearly.
  const segmentIndex = new Map<string, CartridgeSegment[]>();
  for (const segment of segments ?? []) {
    const key = `${segment.bank}:${segment.slot === "ROML" ? "ROML" : "ROMH"}`;
    const bucket = segmentIndex.get(key);
    if (bucket) bucket.push(segment);
    else segmentIndex.set(key, [segment]);
  }

  // Each chunk carries one or more `spans` describing per-bank physical
  // placement (for files that cross bank boundaries). We index per
  // (bank, slot) to one entry per span — clicking any span selects the
  // whole logical chunk.
  type ChunkSpanEntry = { chunk: CartridgeLutChunk; offsetInBank: number; length: number; isContinuation: boolean; isHead: boolean };
  const chunkIndex = new Map<string, ChunkSpanEntry[]>();
  for (const chunk of visibleChunks) {
    const slotKey = chunk.slot === "ROML" ? "ROML" : "ROMH";
    const spans = chunk.spans?.length
      ? chunk.spans
      : [{ bank: chunk.bank, offsetInBank: chunk.offsetInBank, length: chunk.length }];
    spans.forEach((span, spanIndex) => {
      const key = `${span.bank}:${slotKey}`;
      const bucket = chunkIndex.get(key) ?? [];
      bucket.push({
        chunk,
        offsetInBank: span.offsetInBank,
        length: span.length,
        isContinuation: spanIndex > 0,
        isHead: spanIndex === 0,
      });
      chunkIndex.set(key, bucket);
    });
  }

  // Footer stats reflect what the user is currently looking at —
  // visibleChunks already accounts for the LUT filter.
  let sharedChunkCount = 0;
  let totalChunkBytes = 0;
  for (const chunk of visibleChunks) {
    const refs = chunk.refs?.length ? chunk.refs : [{ lut: chunk.lut, index: chunk.index, destAddress: chunk.destAddress }];
    if (refs.length > 1) sharedChunkCount += 1;
    totalChunkBytes += chunk.length;
  }

  function chipAt(bank: number, role: "ROML" | "ROMH"): CartridgeChipView | undefined {
    return chips.find((chip) => chip.bank === bank && (role === "ROML"
      ? chip.slot === "ROML"
      : chip.slot === "ROMH" || chip.slot === "ULTIMAX_ROMH"));
  }

  function renderEmptySegments(role: "ROML" | "ROMH", bank: number) {
    const key = `${bank}:${role}`;
    const regions = emptyIndex.get(key);
    if (!regions || regions.length === 0) return null;
    return (
      <div className="cart-empty-overlay">
        {regions.map((region, idx) => {
          const leftPercent = Math.max(0, Math.min(100, (region.offsetInBank / bankSize) * 100));
          const widthPercent = Math.max(0.5, Math.min(100 - leftPercent, (region.length / bankSize) * 100));
          const tooltip = `free: bank ${region.bank} ${region.slot} off $${region.offsetInBank.toString(16).toUpperCase().padStart(4, "0")} (${region.length} B, $FF)`;
          return (
            <div
              key={`${region.offsetInBank}-${idx}`}
              className="cart-empty-segment"
              style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
              title={tooltip}
            />
          );
        })}
      </div>
    );
  }

  function renderResidentSegments(role: "ROML" | "ROMH", bank: number) {
    const key = `${bank}:${role}`;
    const list = segmentIndex.get(key);
    if (!list || list.length === 0) return null;
    return (
      <div className="cart-empty-overlay">
        {list.map((segment, idx) => {
          const leftPercent = Math.max(0, Math.min(100, (segment.offsetInBank / bankSize) * 100));
          const widthPercent = Math.max(0.5, Math.min(100 - leftPercent, (segment.length / bankSize) * 100));
          const klass = `cart-segment-overlay cart-segment-${segment.kind}`;
          const labelFragment = segment.label ? `${segment.label} · ` : "";
          const destFragment = segment.destAddress !== undefined ? ` → $${segment.destAddress.toString(16).toUpperCase().padStart(4, "0")}` : "";
          const tooltip = `${labelFragment}bank ${segment.bank} ${segment.slot} off $${segment.offsetInBank.toString(16).toUpperCase().padStart(4, "0")} (${segment.length} B, ${segment.kind})${destFragment}`;
          const clickable = Boolean(onSelectSegment);
          return (
            <div
              key={`${segment.kind}-${segment.offsetInBank}-${idx}`}
              className={clickable ? `${klass} cart-segment-clickable` : klass}
              style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
              title={tooltip}
              onClick={clickable ? (event) => {
                event.stopPropagation();
                onSelectSegment?.(segment);
              } : undefined}
            />
          );
        })}
      </div>
    );
  }

  function renderChunkSegments(role: "ROML" | "ROMH", bank: number) {
    const key = `${bank}:${role}`;
    const entries = chunkIndex.get(key);
    if (!entries || entries.length === 0) return null;
    // Render larger spans first; tiny ones land on top so they stay
    // clickable even when a neighbour covers most of the bar.
    const ordered = [...entries].sort((a, b) => b.length - a.length);
    return (
      <div className="cart-chunk-overlay">
        {ordered.map((entry) => {
          const leftPercent = Math.max(0, Math.min(100, (entry.offsetInBank / bankSize) * 100));
          const widthPercent = Math.max(0.5, Math.min(100 - leftPercent, (entry.length / bankSize) * 100));
          const totalSpans = entry.chunk.spans?.length ?? 1;
          const fileLength = entry.chunk.length;
          const baseTooltip = entry.chunk.label ?? `${entry.chunk.lut}.${entry.chunk.index} bank ${entry.chunk.bank} (${fileLength} B)`;
          const tooltip = totalSpans > 1
            ? `${baseTooltip} · this bank: ${entry.length} B (${entry.isHead ? "head" : "cont"} ${entry.isHead ? 1 : "n"}/${totalSpans})`
            : baseTooltip;
          const className = entry.isContinuation ? "cart-chunk-segment cart-chunk-segment-continuation" : "cart-chunk-segment";
          return (
            <div
              key={`${entry.chunk.bank}-${entry.chunk.offsetInBank}-${entry.chunk.length}-${entry.offsetInBank}`}
              className={className}
              style={{
                left: `${leftPercent}%`,
                width: `${widthPercent}%`,
                top: 0,
                height: "100%",
                background: entry.chunk.color ?? "rgba(120,180,255,0.7)",
              }}
              title={tooltip}
              onClick={(event) => {
                event.stopPropagation();
                onSelectLutChunk?.(entry.chunk);
              }}
            />
          );
        })}
      </div>
    );
  }

  function renderSlotBar(chip: CartridgeChipView | undefined, color: string, role: "ROML" | "ROMH", bank: number) {
    if (!chip) {
      return (
        <div className="cart-slot-bar cart-slot-bar-empty" style={{ background: EMPTY_COLOR }} title="empty">
          {renderEmptySegments(role, bank)}
          {renderChunkSegments(role, bank)}
        </div>
      );
    }
    const widthPercent = Math.min(100, Math.max(4, (chip.size / bankSize) * 100));
    const hasChunks = chunkIndex.has(`${bank}:${role}`);
    const targetAddress = role === "ROMH" && isUltimax ? 0xe000 : (role === "ROMH" ? 0xa000 : 0x8000);
    const tooltip = `${role} bank ${chip.bank} → ${formatHexWord(targetAddress)} (${bytesPretty(chip.size)}${chip.file ? ` · ${chip.file}` : ""})`;
    return (
      <button
        type="button"
        className={hasChunks ? "cart-slot-bar cart-slot-bar-clickable cart-slot-bar-chunked" : "cart-slot-bar cart-slot-bar-clickable"}
        style={{ background: hasChunks ? "rgba(40,46,55,0.55)" : color, width: `${widthPercent}%` }}
        title={tooltip}
        onClick={() => onSelectChip?.(chip, role)}
      >
        {renderEmptySegments(role, bank)}
        {renderResidentSegments(role, bank)}
        {renderChunkSegments(role, bank)}
        <span className="cart-slot-bar-label">{role}</span>
      </button>
    );
  }

  return (
    <div className="cart-grid-card">
      <header className="cart-grid-header">
        <div>
          <h4>{cartridgeName}</h4>
          <p>
            {hardwareTypeName ?? "Unknown type"}
            {hardwareType !== undefined ? ` · HW ${hardwareType}` : ""}
            {exrom !== undefined && game !== undefined ? ` · EXROM=${exrom} GAME=${game}${isUltimax ? " (Ultimax)" : ""}` : ""}
          </p>
        </div>
        <dl className="cart-grid-stats">
          <div>
            <dt>Banks</dt>
            <dd>{slotLayout?.bankCount ?? banks.length}</dd>
          </div>
          <div>
            <dt>ROM</dt>
            <dd>{bytesPretty(slotLayout?.totalRomBytes ?? chips.reduce((sum, chip) => sum + chip.size, 0))}</dd>
          </div>
          <div>
            <dt>Slots</dt>
            <dd>{hasRomh ? "ROML + ROMH" : "ROML"}</dd>
          </div>
        </dl>
      </header>
      {startup ? (
        <div className="cart-startup-row">
          <span className={startup.hasCbm80Signature ? "cart-startup-tag cart-startup-tag-ok" : "cart-startup-tag cart-startup-tag-missing"}>
            {startup.hasCbm80Signature ? `${startup.cbm80Tag ?? "CBM80"} ✓` : "no CBM80 head"}
          </span>
          {startup.hasCbm80Signature && startup.startupBank !== undefined ? (
            <span>
              startup bank {String(startup.startupBank).padStart(2, "0")} {startup.startupSlot ?? "ROML"}
            </span>
          ) : null}
          {startup.coldStartVector !== undefined ? (
            <span>cold $<code>{startup.coldStartVector.toString(16).toUpperCase().padStart(4, "0")}</code></span>
          ) : null}
          {startup.warmStartVector !== undefined ? (
            <span>warm $<code>{startup.warmStartVector.toString(16).toUpperCase().padStart(4, "0")}</code></span>
          ) : null}
        </div>
      ) : null}
      {lutPills.length > 0 ? (
        <div className="cart-lut-filter">
          <span className="cart-lut-filter-title">LUT</span>
          <button
            type="button"
            className={activeLut === "all" ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
            onClick={() => setActiveLut("all")}
          >
            <span>all</span>
            <span className="cart-lut-pill-count">{lutChunks?.length ?? 0}</span>
          </button>
          {lutPills.map(([lutName, count]) => (
            <button
              key={lutName}
              type="button"
              className={activeLut === lutName ? "cart-lut-pill cart-lut-pill-active" : "cart-lut-pill"}
              onClick={() => setActiveLut(lutName)}
            >
              <span>{lutName}</span>
              <span className="cart-lut-pill-count">{count}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="cart-grid-banks">
        {banks.length === 0 ? (
          <div className="cart-grid-empty">No bank entries in manifest.</div>
        ) : (
          banks.map((bank) => {
            const roml = chipAt(bank.bank, "ROML");
            const romh = hasRomh ? chipAt(bank.bank, "ROMH") : undefined;
            const monChip = roml ?? romh;
            return (
              <div key={`bank-${bank.bank}`} className="cart-grid-bank">
                <button
                  type="button"
                  className="cart-bank-mon-button"
                  title={monChip?.file ? `Open hex view for bank ${bank.bank} (${monChip.file})` : "No chip dump for this bank"}
                  disabled={!monChip || !onOpenBankHex}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (monChip && onOpenBankHex) onOpenBankHex(bank, monChip);
                  }}
                >
                  mon
                </button>
                <button
                  type="button"
                  className="cart-grid-bank-label"
                  onClick={() => onSelectBank?.(bank)}
                  title={`Bank ${bank.bank}${bank.file ? ` · ${bank.file}` : ""}`}
                >
                  Bank {String(bank.bank).padStart(2, "0")}
                </button>
                <div className="cart-grid-slots">
                  <div className="cart-grid-slot-row">{renderSlotBar(roml, ROML_COLOR, "ROML", bank.bank)}</div>
                  {hasRomh ? (
                    <div className="cart-grid-slot-row">{renderSlotBar(romh, ROMH_COLOR, "ROMH", bank.bank)}</div>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
      {hasEeprom ? (
        <div className="cart-grid-eeprom">
          <header>
            <strong>EEPROM</strong>
            <span>{slotLayout?.eeprom?.kindHint ?? "SPI"}</span>
            {slotLayout?.eeprom?.sizeBytes !== undefined ? <span>{bytesPretty(slotLayout.eeprom.sizeBytes)}</span> : null}
          </header>
          <div className="cart-grid-eeprom-body">
            {slotLayout?.eeprom?.file ? (
              <span>{slotLayout.eeprom.file}</span>
            ) : (
              <span>No EEPROM dump in manifest.</span>
            )}
            {onOpenEepromHex && slotLayout?.eeprom?.file ? (
              <button type="button" className="cart-mon-button" onClick={onOpenEepromHex}>
                mon
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      <footer className="cart-grid-footer">
        <span>
          Bank size {formatHexByte(bankSize >> 8)}00 · slot bar fills relative to bank size
          {visibleChunks.length ? ` · showing ${visibleChunks.length} file chunks (${bytesPretty(totalChunkBytes)})` : ""}
          {sharedChunkCount > 0 ? ` · ${sharedChunkCount} shared across LUTs` : ""}
        </span>
      </footer>
    </div>
  );
}
