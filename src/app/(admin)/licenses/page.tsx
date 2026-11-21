import { Check, ShieldCheck } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function LicensesPage() {
  const activeFeatures = [
    "Independent Varunya company branding & custom favicon",
    "Unlimited user accounts & administrator management",
    "Shared inboxes with granular access delegation",
    "Inbound and outbound email routing & forwarding",
    "Multi-host calendar booking & event management",
    "Cloudflare Email Routing & Resend API delivery",
    "Full-text search, spam protection & audit logging",
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-medium text-neutral-900">Platform Status & License</h1>
        <p className="mt-2 text-sm text-neutral-500">
          Varunya Mail self-hosted deployment information and open-source licensing.
        </p>
      </div>

      <Card className="rounded-3xl border-0 bg-white p-6">
        <CardHeader className="py-0">
          <div className="flex items-center justify-between">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-green-100 text-green-700">
              <ShieldCheck className="h-6 w-6" />
            </span>
            <Badge variant="outline" className="border-green-300 bg-green-50 text-green-700">
              Active / Unlimited
            </Badge>
          </div>
          <CardTitle className="mt-4">Varunya Mail — Enterprise Self-Hosted</CardTitle>
          <CardDescription>
            Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). All platform features are unlocked and operating without external commercial license dependencies.
          </CardDescription>
        </CardHeader>
        <CardContent className="mt-6 space-y-3 pt-0">
          <h2 className="text-sm font-medium text-neutral-900">Active Capabilities:</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {activeFeatures.map((feature) => (
              <p key={feature} className="flex items-center gap-2 text-sm text-neutral-600">
                <Check className="h-4 w-4 shrink-0 text-green-600" />
                {feature}
              </p>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

