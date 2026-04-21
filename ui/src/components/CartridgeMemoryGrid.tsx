import type { CartridgeBankView, CartridgeChipView, CartridgeLutChunk, CartridgeSlotLayout } from "../types.js";

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
  onSelectChip?: ChipClickHandler;
  onSelectBank?: BankClickHandler;
  onOpenChipHex?: ChipClickHandler;
  onOpenEepromHex?: () => void;
  onSelectLutChunk?: (chunk: CartridgeLutChunk) => void;
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
  onSelectChip,
  onSelectBank,
  onOpenChipHex,
  onOpenEepromHex,
  onSelectLutChunk,
}: CartridgeMemoryGridProps) {
  const bankSize = slotLayout?.bankSize ?? 0x2000;
  const hasRomh = slotLayout?.hasRomh ?? chips.some((chip) => chip.slot === "ROMH" || chip.slot === "ULTIMAX_ROMH");
  const hasEeprom = slotLayout?.hasEeprom ?? false;
  const isUltimax = slotLayout?.isUltimax ?? (exrom === 1 && game === 0);
  const hardwareTypeName = slotLayout?.hardwareTypeName ?? (hardwareType !== undefined ? `Type ${hardwareType}` : undefined);

  // Group LUT chunks by bank + slot key for fast per-bar lookup.
  const chunkIndex = new Map<string, CartridgeLutChunk[]>();
  for (const chunk of lutChunks ?? []) {
    const key = `${chunk.bank}:${chunk.slot === "ROML" ? "ROML" : "ROMH"}`;
    const bucket = chunkIndex.get(key);
    if (bucket) bucket.push(chunk);
    else chunkIndex.set(key, [chunk]);
  }

  // Count LUT references across every (deduplicated) chunk so the
  // legend can summarise how often each LUT touches the cart without
  // pretending colour maps to LUT identity.
  const lutRefCounts = new Map<string, number>();
  let sharedChunkCount = 0;
  let totalChunkBytes = 0;
  for (const chunk of lutChunks ?? []) {
    const refs = chunk.refs?.length ? chunk.refs : [{ lut: chunk.lut, index: chunk.index, destAddress: chunk.destAddress }];
    if (refs.length > 1) sharedChunkCount += 1;
    totalChunkBytes += chunk.length;
    for (const ref of refs) {
      lutRefCounts.set(ref.lut, (lutRefCounts.get(ref.lut) ?? 0) + 1);
    }
  }

  function chipAt(bank: number, role: "ROML" | "ROMH"): CartridgeChipView | undefined {
    return chips.find((chip) => chip.bank === bank && (role === "ROML"
      ? chip.slot === "ROML"
      : chip.slot === "ROMH" || chip.slot === "ULTIMAX_ROMH"));
  }

  function renderChunkSegments(role: "ROML" | "ROMH", bank: number) {
    const key = `${bank}:${role}`;
    const chunks = chunkIndex.get(key);
    if (!chunks || chunks.length === 0) return null;
    // Render larger chunks first; tiny ones land on top so they stay
    // clickable even when a neighbour covers most of the bar.
    const ordered = [...chunks].sort((a, b) => b.length - a.length);
    return (
      <div className="cart-chunk-overlay">
        {ordered.map((chunk) => {
          const leftPercent = Math.max(0, Math.min(100, (chunk.offsetInBank / bankSize) * 100));
          const widthPercent = Math.max(0.5, Math.min(100 - leftPercent, (chunk.length / bankSize) * 100));
          const tooltip = chunk.label ?? `${chunk.lut}.${chunk.index} bank ${chunk.bank} (${chunk.length} B)`;
          return (
            <div
              key={`${chunk.offsetInBank}-${chunk.length}`}
              className="cart-chunk-segment"
              style={{
                left: `${leftPercent}%`,
                width: `${widthPercent}%`,
                top: 0,
                height: "100%",
                background: chunk.color ?? "rgba(120,180,255,0.7)",
              }}
              title={tooltip}
              onClick={(event) => {
                event.stopPropagation();
                onSelectLutChunk?.(chunk);
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
      <div className="cart-grid-banks">
        {banks.length === 0 ? (
          <div className="cart-grid-empty">No bank entries in manifest.</div>
        ) : (
          banks.map((bank) => {
            const roml = chipAt(bank.bank, "ROML");
            const romh = hasRomh ? chipAt(bank.bank, "ROMH") : undefined;
            return (
              <div key={`bank-${bank.bank}`} className="cart-grid-bank">
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
      {lutRefCounts.size > 0 ? (
        <div className="cart-grid-legend">
          <span className="cart-grid-legend-title">LUT refs:</span>
          {Array.from(lutRefCounts.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([lutName, count]) => (
              <span key={lutName} className="cart-grid-legend-entry">
                <span>{lutName}</span>
                <span className="cart-grid-legend-count">{count}</span>
              </span>
            ))}
          {sharedChunkCount > 0 ? (
            <span className="cart-grid-legend-entry">
              <span>shared</span>
              <span className="cart-grid-legend-count">{sharedChunkCount}</span>
            </span>
          ) : null}
        </div>
      ) : null}
      <footer className="cart-grid-footer">
        <span>
          Bank size {formatHexByte(bankSize >> 8)}00 · slot bar fills relative to bank size
          {lutChunks?.length ? ` · ${lutChunks.length} unique file chunks (${bytesPretty(totalChunkBytes)} mapped)` : ""}
        </span>
      </footer>
    </div>
  );
}
