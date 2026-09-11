const fs = require('fs');

let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', 'utf8');

const bannerCode = `
      {data.pausedOffline && (
        <div className="mb-4 bg-[var(--status-amber-bg)] border border-[var(--status-amber)] text-[var(--status-amber)] px-4 py-3 rounded-md flex items-center gap-3 text-sm font-medium">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p>Action Center is paused for offline/simulated cases. Only Demo-authorized actions on allowed rows are available.</p>
        </div>
      )}
      {totalActionable === 0 ? (`;

content = content.replace(
  '{totalActionable === 0 ? (',
  bannerCode
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/action-center-tabs.tsx', content);

