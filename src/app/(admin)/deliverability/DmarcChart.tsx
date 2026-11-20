import { useLanguage } from "@/components/language-provider";
import type { DmarcSeriesDay } from "./types";
import { chartMax, dayTotal, segmentPercents } from "./dmarc-utils";

const SEGMENTS = [
	{ key: "pass", color: "bg-green-600" },
	{ key: "failDelivered", color: "bg-amber-500" },
	{ key: "quarantined", color: "bg-orange-600" },
	{ key: "rejected", color: "bg-red-700" },
] as const;

/** Daily stacked bars. The bars are decoration; the same numbers are in a table for screen readers. */
export function DmarcChart({ series }: { series: DmarcSeriesDay[] }) {
	const { t } = useLanguage();
	const max = chartMax(series);
	const label = (day: DmarcSeriesDay) => t("dmarc.chart.barTitle", { day: day.day, pass: day.pass, failDelivered: day.failDelivered, quarantined: day.quarantined, rejected: day.rejected });
	return <section className="rounded-2xl bg-white p-5">
		<div className="flex flex-wrap items-center justify-between gap-3">
			<h3 className="text-base font-semibold text-neutral-900">{t("dmarc.chart.title")}</h3>
			<ul className="flex flex-wrap items-center gap-4 text-xs text-neutral-700">
				{SEGMENTS.map((segment) => <li key={segment.key} className="flex items-center gap-1.5"><span aria-hidden className={`h-2.5 w-2.5 rounded-sm ${segment.color}`} />{t(`dmarc.legend.${segment.key}`)}</li>)}
			</ul>
		</div>
		{max === 0 && <p className="mt-4 text-sm text-neutral-500">{t("dmarc.chart.empty")}</p>}
		{max > 0 && <div className="mt-5 flex gap-3" role="img" aria-label={t("dmarc.chart.label")}>
			<div aria-hidden className="flex h-48 flex-col justify-between pb-5 text-right text-[10px] text-neutral-500"><span>{max.toLocaleString()}</span><span>0</span></div>
			<div className="flex min-w-0 flex-1 items-end gap-1 border-b border-neutral-200">
				{series.map((day, index) => {
					const shares = segmentPercents(day, max);
					return <div key={day.day} title={label(day)} className="flex h-48 min-w-0 flex-1 flex-col items-center">
						<div className="flex h-[172px] w-full items-end justify-center"><div className="flex w-full max-w-5 flex-col-reverse overflow-hidden rounded-t-sm" style={{ height: `${shares.height}%` }}>
							{SEGMENTS.map((segment) => shares[segment.key] > 0 && <div key={segment.key} className={segment.color} style={{ height: `${shares[segment.key]}%` }} />)}
						</div></div>
						<span className="h-5 whitespace-nowrap pt-1 text-[9px] text-neutral-500">{index % 5 === 0 || index === series.length - 1 ? day.day.slice(5) : ""}</span>
					</div>;
				})}
			</div>
		</div>}
		<table className="sr-only">
			<caption>{t("dmarc.chart.label")}</caption>
			<thead><tr><th scope="col">{t("dmarc.col.day")}</th>{SEGMENTS.map((segment) => <th key={segment.key} scope="col">{t(`dmarc.legend.${segment.key}`)}</th>)}</tr></thead>
			<tbody>{series.filter((day) => dayTotal(day) > 0).map((day) => <tr key={day.day}><th scope="row">{day.day}</th>{SEGMENTS.map((segment) => <td key={segment.key}>{day[segment.key]}</td>)}</tr>)}</tbody>
		</table>
	</section>;
}
