/**
 * Only disposable browser-harness identities may resolve here. This adapter
 * never enrolls MFA, verifies an address, or supplies private admin approval.
 */
export function installBrowserIdentityReader(client, identities, environment = process.env) {
  if (environment.NODE_ENV !== "test" || environment.ONBOARDING_E2E_TEST !== "true") {
    throw new Error("Browser identity reader requires the isolated test environment.");
  }
  const original = client.users.getUser;
  client.users.getUser = async id => {
    const details = identities.get(id);
    if (!details) throw new Error("Unknown identity outside the owned browser fixture.");
    const emailId = `browser-fixture-email:${id}`;
    return {
      id, firstName: details.firstName, lastName: details.lastName,
      fullName: `${details.firstName} ${details.lastName}`,
      primaryEmailAddressId: emailId,
      emailAddresses: [{ id: emailId, emailAddress: details.email, verification: { status: "unverified" } }],
      privateMetadata: {}, publicMetadata: {}, unsafeMetadata: {}, twoFactorEnabled: false,
    };
  };
  return () => { client.users.getUser = original; };
}
