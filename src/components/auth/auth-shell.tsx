"use client";

import { useEffect, useState } from "react";
import { useBranding } from "@/components/branding-provider";
import { LanguageSelector } from "@/components/language-selector";
import type { AuthShellProps } from "./types";

export function AuthShell({
  icon: Icon,
  title,
  description,
  children,
  footer,
  steps,
  variant = "split",
}: AuthShellProps) {
  const branding = useBranding();
  const [iconUrl, setIconUrl] = useState(branding.iconUrl);
  const [iconFailed, setIconFailed] = useState(false);

  useEffect(() => {
    setIconUrl(branding.iconUrl);
    setIconFailed(false);
  }, [branding.iconUrl]);

  const brand = (
    <div className={variant === "centered" ? "flex items-center justify-center gap-2" : "flex items-center gap-2"}>
      <span className="flex items-center justify-center overflow-hidden">
        {iconFailed ? (
          <Icon className="h-8 w-8 text-blue-600" />
        ) : (
          <img
            src={iconUrl}
            onError={() => {
              if (iconUrl !== "/icon-96.png") setIconUrl("/icon-96.png");
              else setIconFailed(true);
            }}
            alt=""
            className="h-8 w-8 object-contain"
          />
        )}
      </span>
      <span className="truncate text-md font-semibold text-neutral-800">
        {branding.appName}
      </span>
    </div>
  );

  if (variant === "centered") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center bg-[#f1f4fa] px-4 py-10 text-neutral-900">
        <main className="w-full max-w-md rounded-3xl bg-white p-7 sm:p-10">
          {brand}
          <h1 className="mt-6 text-center text-2xl font-medium tracking-tight text-neutral-950">
            {title}
          </h1>
          {description && (
            <p className="mt-2 text-center text-sm leading-6 text-neutral-600">
              {description}
            </p>
          )}
          <div className="mt-8">{children}</div>
          {footer && (
            <div className="mt-6 text-center text-sm font-medium text-blue-700">
              {footer}
            </div>
          )}
        </main>
        <div className="mt-6 w-48">
          <LanguageSelector />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-[#f1f4fa] px-4 py-6 text-neutral-900 sm:px-6 lg:flex lg:items-center lg:px-10 lg:py-10">
      <main className="mx-auto grid w-full max-w-6xl overflow-hidden rounded-4xl bg-white lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        <section className="flex flex-col p-7 sm:p-10 lg:p-14">
          {brand}

          <div className="mt-2 lg:mt-8">
            <h1 className="max-w-md text-xl font-medium leading-tight tracking-tight text-neutral-950 sm:text-4xl">
              {title}
            </h1>
            {description && (
              <p className="mt-5 max-w-md text-base leading-7 text-neutral-600">
                {description}
              </p>
            )}
          </div>
        </section>

        <section className="flex min-w-0 flex-col justify-center p-7 sm:p-10 lg:p-14">
          {steps && (
            <div className="mb-7 flex flex-wrap gap-2 text-xs font-semibold">
              {steps.map((step, index) => (
                <span key={step.label} className="flex items-center gap-2">
                  <span
                    className={
                      step.active ? "text-blue-700" : "text-neutral-500"
                    }
                  >
                    {index + 1} {step.label}
                  </span>
                  {index < steps.length - 1 && (
                    <span className="text-neutral-300">/</span>
                  )}
                </span>
              ))}
            </div>
          )}
          <div className="w-full">{children}</div>
          <div className="mt-8 max-w-48">
            <LanguageSelector />
          </div>
          {footer && (
            <div className="mt-8 text-sm font-medium text-blue-700">
              {footer}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
