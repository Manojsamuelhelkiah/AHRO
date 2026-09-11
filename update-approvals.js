const fs = require('fs');

let content = fs.readFileSync('artifacts/onboarding-agent/src/pages/approvals.tsx', 'utf8');

content = content.replace(
  "import { Link } from 'wouter';",
  "import { Link, useLocation } from 'wouter';\nimport { useEffect } from 'react';"
);

content = content.replace(
  "const [activeTab, setActiveTab] = useState('approvals');",
  `const [location, setLocation] = useLocation();
  const searchParams = new URLSearchParams(window.location.search);
  const tabParam = searchParams.get('tab');
  
  const activeTab = tabParam || 'needs-attention';

  const setActiveTab = (val: string) => {
    setLocation(location + '?tab=' + val);
  };`
);

fs.writeFileSync('artifacts/onboarding-agent/src/pages/approvals.tsx', content);
