const fs = require('fs');
let code = fs.readFileSync('artifacts/onboarding-agent/src/pages/approvals.tsx', 'utf8');

const regex = /const \[showAll, setShowAll\] = useState\(false\);/;

const replacement = `const searchParams = new URLSearchParams(window.location.search);
  const filterCaseId = searchParams.get('caseId');
  const filterApprovalId = searchParams.get('approvalId');
  const filterApprovalRef = searchParams.get('approvalRef');
  const hasFilter = filterCaseId || filterApprovalId || filterApprovalRef;
  const [showAll, setShowAll] = useState(!!hasFilter);`;

code = code.replace(regex, replacement);

const returnRegex = /return \(\n    <div className="space-y-4">/;
const returnReplacement = `return (
    <div className="space-y-4">
      {hasFilter && (
        <div className="bg-[var(--primary-light)] border border-[var(--primary)] text-[var(--primary)] px-4 py-3 rounded-md flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">Filtered View Active:</span>
            <div className="flex gap-2 text-xs">
              {filterCaseId && <Badge variant="outline" className="bg-white/50">Case #{filterCaseId}</Badge>}
              {filterApprovalId && <Badge variant="outline" className="bg-white/50">Approval #{filterApprovalId}</Badge>}
              {filterApprovalRef && <Badge variant="outline" className="bg-white/50">Ref: {filterApprovalRef}</Badge>}
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => window.location.href = '?tab=approvals'}>Clear Filters</Button>
        </div>
      )}`;

code = code.replace(returnRegex, returnReplacement);

const mapRegex = /approvals\?\.map\(app => \(\n          <ApprovalCard key=\{app.id\} approval=\{app\} statusParam=\{statusParam\} \/>\n        \)\)/;
const mapReplacement = `approvals?.filter(app => {
          if (filterCaseId && app.caseId.toString() !== filterCaseId) return false;
          if (filterApprovalId && app.id.toString() !== filterApprovalId) return false;
          if (filterApprovalRef && app.ruleRef !== filterApprovalRef) return false;
          return true;
        }).map(app => (
          <ApprovalCard key={app.id} approval={app} statusParam={statusParam} />
        ))`;

code = code.replace(mapRegex, mapReplacement);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/approvals.tsx', code);
