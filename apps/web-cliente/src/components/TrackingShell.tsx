import type { ReactNode } from "react";

type Props = {
  title: string;
  subtitle?: string;
  children: ReactNode;
};

export function TrackingShell({ title, subtitle, children }: Props) {
  return (
    <div id="app">
      <header>
        <p className="eyebrow">Entrega de hoy</p>
        <h1>{title}</h1>
        {subtitle ? <p className="pill">{subtitle}</p> : null}
      </header>
      {children}
    </div>
  );
}
