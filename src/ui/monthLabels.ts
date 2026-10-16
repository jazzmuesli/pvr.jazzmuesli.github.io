import { monthKeys, t } from "../i18n";

/**
 * Month label from the translation catalogue.
 *
 * The report used to carry hard-coded German abbreviations
 * (`report.ts: MONTH_LABELS`), so switching the app to English left the monthly
 * chart, its tooltips and the Excel export reading "Mär / Mai / Okt / Dez"
 * while the hourly chart beside them was correctly translated. The domain now
 * publishes a `monthKey`; the label is looked up here, where the locale lives.
 */
export function monthLabel(month: number): string {
  return t(`month.${monthKeys()[month - 1]}`);
}