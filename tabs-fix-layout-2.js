const fs = require('fs');
let code = fs.readFileSync('artifacts/onboarding-agent/src/pages/approvals.tsx', 'utf8');

code = code.replace(
  `          <TabsTrigger value="needs-attention">Needs Attention</TabsTrigger>
          <TabsTrigger value="approvals">Approvals</TabsTrigger>
          <TabsTrigger value="communications">Communications</TabsTrigger>
          <TabsTrigger value="completed">Completed</TabsTrigger>
        </TabsList>`,
  ''
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/approvals.tsx', code);
