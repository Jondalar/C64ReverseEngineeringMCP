import type { CartridgeBankView, CartridgeChipView, CartridgeSlotLayout } from "../types.js";

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
  onSelectChip?: ChipClickHandler;
  onSelectBank?: BankClickHandler;
  onOpenChipHex?: ChipClickHandler;
  onOpenEepromHex?: () => void;
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
  onSelectChip,
  onSelectBank,
  onOpenChipHex,
  onOpenEepromHex,
}: CartridgeMemoryGridProps) {
  const bankSize = slotLayout?.bankSize ?? 0x2000;
  const hasRomh = slotLayout?.hasRomh ?? chips.some((chip) => chip.slot === "ROMH" || chip.slot === "ULTIMAX_ROMH");
  const hasEeprom = slotLayout?.hasEeprom ?? false;
  const isUltimax = slotLayout?.isUltimax ?? (exrom === 1 && game === 0);
  const hardwareTypeName = slotLayout?.hardwareTypeName ?? (hardwareType !== undefined ? `Type ${hardwareType}` : undefined);

  function chipAt(bank: number, role: "ROML" | "ROMH"): CartridgeChipView | undefined {
    return chips.find((chip) => chip.bank === bank && (role === "ROML"
      ? chip.slot === "ROML"
      : chip.slot === "ROMH" || chip.slot === "ULTIMAX_ROMH"));
  }

  function renderSlotBar(chip: CartridgeChipView | undefined, color: string, role: "ROML" | "ROMH") {
    if (!chip) {
      return <div className="cart-slot-bar" style={{ background: EMPTY_COLOR }} title="empty" />;
    }
    const widthPercent = Math.min(100, Math.max(4, (chip.size / bankSize) * 100));
    const targetAddress = role === "ROMH" && isUltimax ? 0xe000 : (role === "ROMH" ? 0xa000 : 0x8000);
    const tooltip = `${role} bank ${chip.bank} → ${formatHexWord(targetAddress)} (${bytesPretty(chip.size)}${chip.file ? ` · ${chip.file}` : ""})`;
    return (
      <button
        type="button"
        className="cart-slot-bar cart-slot-bar-clickable"
        style={{ background: color, width: `${widthPercent}%` }}
        title={tooltip}
        onClick={() => onSelectChip?.(chip, role)}
      >
        <span className="cart-slot-bar-label">{role}</span>
        {onOpenChipHex ? (
          <span
            className="cart-mon-icon"
            role="button"
            aria-label={`Open hex view for ${role} bank ${chip.bank}`}
            onClick={(event) => {
              event.stopPropagation();
              onOpenChipHex(chip, role);
            }}
          >
            mon
          </span>
        ) : null}
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
                  <div className="cart-grid-slot-row">{renderSlotBar(roml, ROML_COLOR, "ROML")}</div>
                  {hasRomh ? (
                    <div className="cart-grid-slot-row">{renderSlotBar(romh, ROMH_COLOR, "ROMH")}</div>
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
        <span>Bank size {formatHexByte(bankSize >> 8)}00 · slot bar fills relative to bank size</span>
      </footer>
    </div>
  );
}
