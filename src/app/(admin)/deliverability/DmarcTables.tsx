import { useLanguage } from "@/components/language-provider";
import type { DmarcStats } from "./types";
import { percent, reportStatusKey } from "./dmarc-utils";
import { formatEventDate } from "./utils";

const head = "px-4 py-3";

function Table({ title, minWidth, children }: { title: string; minWidth: string; children: React.ReactNode }) {
	return <section className="space-y-3">
		<h3 className="text-sm font-semibold text-neutral-900">{title}</h3>
		<div role="region" tabIndex={0} aria-label={title} className="overflow-x-auto rounded-2xl bg-white"><table className={`w-full ${minWidth} text-left text-sm`}>{children}</table></div>
	</section>;
}

const Th = ({ children, right }: { children: React.ReactNode; right?: boolean }) => <th scope="col" className={`${head}${right ? " text-right" : ""}`}>{children}</th>;
const headClass = "border-b border-neutral-100 bg-neutral-50 text-xs font-semibold uppercase tracking-wide text-neutral-500";

export function DmarcTables({ stats }: { stats: DmarcStats }) {
	const { t } = useLanguage();
	const empty = (columns: number, key: "dmarc.sources.empty" | "dmarc.reporters.empty" | "dmarc.recent.empty") => <tr><td colSpan={columns} className="px-4 py-8 text-center text-neutral-500">{t(key)}</td></tr>;
	return <>
		<Table title={t("dmarc.sources.title")} minWidth="min-w-[860px]">
			<thead className={headClass}><tr><Th>{t("dmarc.col.ip")}</Th><Th>{t("dmarc.col.host")}</Th><Th right>{t("dmarc.col.reporters")}</Th><Th right>{t("dmarc.col.messages")}</Th><Th right>{t("dmarc.col.passRate")}</Th><Th right>{t("dmarc.col.dkimRate")}</Th><Th right>{t("dmarc.col.spfRate")}</Th><Th>{t("dmarc.col.worst")}</Th></tr></thead>
			<tbody className="divide-y divide-neutral-100">
				{stats.sources.map((row) => <tr key={row.sourceIp}>
					<td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{row.sourceIp}</td>
					<td className="max-w-56 break-all px-4 py-3">{row.sourceHost ?? ""}</td>
					<td className="px-4 py-3 text-right tabular-nums">{row.reporters}</td>
					<td className="px-4 py-3 text-right tabular-nums">{row.messages.toLocaleString()}</td>
					<td className="px-4 py-3 text-right tabular-nums">{percent(row.passMessages, row.messages)}%</td>
					<td className="px-4 py-3 text-right tabular-nums">{percent(row.dkimMessages, row.messages)}%</td>
					<td className="px-4 py-3 text-right tabular-nums">{percent(row.spfMessages, row.messages)}%</td>
					<td className="px-4 py-3">{t(`dmarc.worst.${row.worstDisposition}`)}</td>
				</tr>)}
				{stats.sources.length === 0 && empty(8, "dmarc.sources.empty")}
			</tbody>
		</Table>
		<Table title={t("dmarc.reporters.title")} minWidth="min-w-[520px]">
			<thead className={headClass}><tr><Th>{t("dmarc.col.reporter")}</Th><Th right>{t("dmarc.col.reports")}</Th><Th right>{t("dmarc.col.messages")}</Th><Th right>{t("dmarc.col.passRate")}</Th></tr></thead>
			<tbody className="divide-y divide-neutral-100">
				{stats.reporters.map((row) => <tr key={row.reporterOrg}>
					<td className="break-all px-4 py-3">{row.reporterOrg}</td>
					<td className="px-4 py-3 text-right tabular-nums">{row.reports}</td>
					<td className="px-4 py-3 text-right tabular-nums">{row.messages.toLocaleString()}</td>
					<td className="px-4 py-3 text-right tabular-nums">{percent(row.passMessages, row.messages)}%</td>
				</tr>)}
				{stats.reporters.length === 0 && empty(4, "dmarc.reporters.empty")}
			</tbody>
		</Table>
		<Table title={t("dmarc.recent.title")} minWidth="min-w-[640px]">
			<thead className={headClass}><tr><Th>{t("dmarc.col.received")}</Th><Th>{t("dmarc.col.reporter")}</Th><Th right>{t("dmarc.col.messages")}</Th><Th>{t("dmarc.col.status")}</Th></tr></thead>
			<tbody className="divide-y divide-neutral-100">
				{stats.recentReports.map((row) => <tr key={row.id}>
					<td className="whitespace-nowrap px-4 py-3 text-neutral-600">{formatEventDate(row.receivedAt)}</td>
					<td className="break-all px-4 py-3">{row.reporterOrg ?? ""}</td>
					<td className="px-4 py-3 text-right tabular-nums">{row.messageCount.toLocaleString()}</td>
					<td className="px-4 py-3" title={row.error ?? undefined}>{t(`dmarc.status.${reportStatusKey(row.status, row.receivedAt)}`)}</td>
				</tr>)}
				{stats.recentReports.length === 0 && empty(4, "dmarc.recent.empty")}
			</tbody>
		</Table>
	</>;
}
