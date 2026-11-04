import { getServerTranslator } from "@/lib/i18n/server";
import { Check, ExternalLink } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LicenseActivation } from "./license-activation";
import { LICENSE_PLANS } from "./utils";

export default async function LicensesPage() {
  const t = await getServerTranslator();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-medium text-neutral-900">{t("licenses.title")}</h1>
        <p className="mt-2 text-sm text-neutral-500">
          {t("licenses.description")}
        </p>
      </div>
      <LicenseActivation>
      <div className="grid gap-4 md:grid-cols-2">
        {LICENSE_PLANS.map((plan) => {
          const Icon = plan.icon;
          return (
            <Card
              key={plan.name}
              className="rounded-3xl border-0 bg-white p-6 flex flex-col"
            >
              <CardHeader className="space-y-4 py-0">
                <div className="flex items-center justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-blue-700">
                    <Icon className="h-5 w-5" />
                  </span>
                </div>
                <div className="relative">
                  <CardTitle>{plan.name}</CardTitle>
                  <p className="mt-2 text-6xl text-neutral-950 flex">
                    <span className="text-[12px] mt-2">$</span>
                    <b>{plan.price}</b>
                    {plan.originalPrice && (
                      <span className="absolute right-0 bottom-6 line-through text-base opacity-40">
                        ${plan.originalPrice}
                      </span>
                    )}
                  </p>
                </div>
                <CardDescription>{t(plan.descriptionKey)}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 pt-6 flex flex-col flex-1 min-h-0">
                {plan.featureKeys.map((feature) => (
                  <p
                    key={feature}
                    className="flex gap-2 text-sm text-neutral-600"
                  >
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                    {t(feature)}
                  </p>
                ))}
                <span className="flex-1" />
                <Button asChild className="mt-4 w-full">
                  <a
                    href={plan.checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("licenses.get", { plan: plan.name })}
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
      </LicenseActivation>
    </div>
  );
}
