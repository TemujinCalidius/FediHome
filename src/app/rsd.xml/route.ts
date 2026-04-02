export async function GET() {
  const siteUrl = process.env.SITE_URL || "http://localhost:3000";

  const rsd = `<?xml version="1.0" encoding="UTF-8"?>
<rsd version="1.0" xmlns="http://archipelago.phrasewise.com/rsd">
  <service>
    <engineName>FediHome</engineName>
    <engineLink>${siteUrl}</engineLink>
    <homePageLink>${siteUrl}</homePageLink>
    <apis>
      <api name="MetaWeblog" preferred="true" apiLink="${siteUrl}/xmlrpc" blogID="1" />
      <api name="Micropub" preferred="false" apiLink="${siteUrl}/api/micropub" blogID="1" />
    </apis>
  </service>
</rsd>`;

  return new Response(rsd, {
    headers: { "Content-Type": "application/rsd+xml; charset=utf-8" },
  });
}
