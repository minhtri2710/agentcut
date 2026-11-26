// What every page draws with: the Astryx theme (dark), the design system's words in the page's language, the language switch, and a 16 px icon.
import type { ReactNode } from "react";
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

export const ico = (c: IconType) => <Icon icon={c} size="sm" />;
