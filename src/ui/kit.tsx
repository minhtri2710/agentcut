// What every page draws with: the Astryx theme (dark), the design system's words in the page's language, the language switch, and a 16 px icon.
import type { InputHTMLAttributes, ReactNode } from "react";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { Icon, type IconType } from "@astryxdesign/core/Icon";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Theme } from "@astryxdesign/core/theme";
import viVN from "@astryxdesign/core/locales/vi-VN.generated.js";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { getLang, t, type Lang } from "./i18n.ts";

export function Frame({ children }: { children: ReactNode }) {
  const vi = getLang() === "vi";
  return (
    <InternationalizationProvider locale={vi ? "vi-VN" : "en"} messages={vi ? { "vi-VN": viVN } : undefined}>
      <Theme theme={neutralTheme} mode="dark">{children}</Theme>
    </InternationalizationProvider>
  );
}

export function LangSwitch({ onPick }: { onPick: (l: Lang) => void }) {
  return (
    <SegmentedControl id="lang" label={t("language")} size="sm" value={getLang()} onChange={(v) => onPick(v as Lang)}>
      <SegmentedControlItem value="en" label="EN" />
      <SegmentedControlItem value="vi" label="VI" />
    </SegmentedControl>
  );
}

/** a number field in one format whatever the language (a dot decimal: the browser's own number input, so text it cannot read blocks its form's submit);
 *  the wheel scrolls the page instead of stepping a focused field */
export const Num = (p: InputHTMLAttributes<HTMLInputElement>) => <input type="number" className="pnum mono" onWheel={(e) => e.currentTarget.blur()} {...p} />;

/** a number field's value, null when it is empty (an unreadable entry is null too, and the browser blocks the form's submit on it) */
export const numOf = (i: HTMLInputElement) => (Number.isFinite(i.valueAsNumber) ? i.valueAsNumber : null);

/** Enter leaves a field that commits on blur */
export const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); };

export const ico = (c: IconType) => <Icon icon={c} size="sm" />;
