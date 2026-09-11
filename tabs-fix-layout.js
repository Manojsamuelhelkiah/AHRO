const fs = require('fs');
let code = fs.readFileSync('artifacts/onboarding-agent/src/pages/approvals.tsx', 'utf8');

// Fix horizontal scroll for TabsList on mobile
code = code.replace(
  '<TabsList className="w-full grid grid-cols-4 mb-4">',
  '<div className="overflow-x-auto pb-2 -mx-4 px-4 md:mx-0 md:px-0 md:overflow-visible">\n          <TabsList className="w-max md:w-full min-w-full grid grid-cols-4 mb-4">\n            <TabsTrigger value="needs-attention">Needs Attention</TabsTrigger>\n            <TabsTrigger value="approvals">Approvals</TabsTrigger>\n            <TabsTrigger value="communications">Communications</TabsTrigger>\n            <TabsTrigger value="completed">Completed</TabsTrigger>\n          </TabsList>\n        </div>'
);

code = code.replace(
  /<TabsList className="w-full grid grid-cols-4 mb-4">[\s\S]*?<\/TabsList>/,
  ''
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/approvals.tsx', code);
