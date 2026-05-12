// Spec 267 — TraceFilters: cycle slider + family checkboxes + PC/addr range inputs.

import React from "react";

/** All 24 V2 EventFamily values. */
export const ALL_FAMILIES = [
  "cpu_step",
  "mem_read",
  "mem_write",
  "irq_assert",
  "irq_ack",
  "nmi_assert",
  "cpu_jam",
  "mem_indirect_resolve",
  "reset_assert",
  "vic_badline",
  "vic_raster_irq",
  "vic_sprite_collision",
  "vic_dma_steal",
  "cia_timer_underflow",
  "cia_register_read",
  "cia_register_write",
  "via_timer_underflow",
  "via_register_read",
  "via_register_write",
  "sid_register_write",
  "drive_atn_change",
  "drive_clk_change",
  "drive_data_change",
  "gcr_byte",
  "trap_fire",
  "keyboard_press",
  "keyboard_release",
  "hook_audit",
  "breakpoint_hit",
] as const;

export type EventFamily = (typeof ALL_FAMILIES)[number];

/** Default families enabled in the UI. */
export const DEFAULT_ENABLED_FAMILIES = new Set<EventFamily>([
  "cpu_step",
  "mem_write",
  "irq_assert",
  "drive_atn_change",
  "drive_clk_change",
  "drive_data_change",
]);

export interface TraceFilterState {
  cycleStart: number;
  cycleEnd: number;
  maxCycle: number;
  enabledFamilies: Set<EventFamily>;
  pcStart: number;
  pcEnd: number;
  addrStart: number;
  addrEnd: number;
  searchText: string;
}

export function defaultFilterState(maxCycle = 3_000_000): TraceFilterState {
  return {
    cycleStart: 0,
    cycleEnd: maxCycle,
    maxCycle,
    enabledFamilies: new Set(DEFAULT_ENABLED_FAMILIES),
    pcStart: 0x0000,
    pcEnd: 0xffff,
    addrStart: 0x0000,
    addrEnd: 0xffff,
    searchText: "",
  };
}

interface Props {
  state: TraceFilterState;
  onChange: (s: TraceFilterState) => void;
  onSearch: () => void;
}

function hexInput(
  label: string,
  value: number,
  onChange: (v: number) => void,
): JSX.Element {
  return (
    <label className="trace-filter-field">
      {label}
      <input
        className="trace-hex-input"
        type="text"
        value={"$" + value.toString(16).toUpperCase().padStart(4, "0")}
        onChange={(e) => {
          const raw = e.target.value.replace(/^\$/, "");
          const parsed = parseInt(raw, 16);
          if (!isNaN(parsed) && parsed >= 0 && parsed <= 0xffff) {
            onChange(parsed);
          }
        }}
      />
    </label>
  );
}

export function TraceFilters({ state, onChange, onSearch }: Props): JSX.Element {
  function update(patch: Partial<TraceFilterState>): void {
    onChange({ ...state, ...patch });
  }

  function toggleFamily(f: EventFamily): void {
    const next = new Set(state.enabledFamilies);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    update({ enabledFamilies: next });
  }

  const pct = (v: number) => ((v / Math.max(1, state.maxCycle)) * 100).toFixed(1) + "%";

  return (
    <div className="trace-filters">
      {/* Cycle range */}
      <div className="trace-filter-row">
        <span className="trace-filter-label">Cycle range:</span>
        <input
          type="range"
          min={0}
          max={state.maxCycle}
          value={state.cycleStart}
          onChange={(e) => update({ cycleStart: Math.min(Number(e.target.value), state.cycleEnd) })}
          className="trace-slider"
        />
        <span className="trace-cycle-val">{state.cycleStart.toLocaleString()}</span>
        <span className="trace-filter-sep">..</span>
        <input
          type="range"
          min={0}
          max={state.maxCycle}
          value={state.cycleEnd}
          onChange={(e) => update({ cycleEnd: Math.max(Number(e.target.value), state.cycleStart) })}
          className="trace-slider"
        />
        <span className="trace-cycle-val">{state.cycleEnd.toLocaleString()}</span>
        <span className="trace-cycle-pct">({pct(state.cycleEnd - state.cycleStart)} span)</span>
      </div>

      {/* Family checkboxes */}
      <div className="trace-filter-row trace-families-row">
        <span className="trace-filter-label">Families:</span>
        <div className="trace-family-list">
          {ALL_FAMILIES.map((f) => (
            <label key={f} className="trace-family-cb">
              <input
                type="checkbox"
                checked={state.enabledFamilies.has(f)}
                onChange={() => toggleFamily(f)}
              />
              {f}
            </label>
          ))}
        </div>
      </div>

      {/* PC + Addr range */}
      <div className="trace-filter-row">
        <span className="trace-filter-label">PC:</span>
        {hexInput("from", state.pcStart, (v) => update({ pcStart: v }))}
        <span className="trace-filter-sep">–</span>
        {hexInput("to", state.pcEnd, (v) => update({ pcEnd: v }))}

        <span className="trace-filter-label trace-filter-label-ml">Addr:</span>
        {hexInput("from", state.addrStart, (v) => update({ addrStart: v }))}
        <span className="trace-filter-sep">–</span>
        {hexInput("to", state.addrEnd, (v) => update({ addrEnd: v }))}
      </div>

      {/* Search */}
      <div className="trace-filter-row">
        <span className="trace-filter-label">Search:</span>
        <input
          className="trace-search-input"
          type="text"
          placeholder="PC/addr/value hex, e.g. $E5CD or $D020"
          value={state.searchText}
          onChange={(e) => update({ searchText: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter") onSearch(); }}
        />
        <button className="trace-btn" onClick={onSearch}>find</button>
      </div>
    </div>
  );
}
