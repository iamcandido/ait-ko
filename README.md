# AiT.KO

Natural-language, read-only queries for the Okta Admin API, from inside the Okta Admin Console.
Describe what you want in plain language (for example "active users in the Finance department with
countryCode PT", "apps assigned to group 00g1abc", or "failed sign-ins in the last 24 hours"),
review the generated request, run it with your existing admin session (no API token), and export the results to CSV or JSON.

AiT.KO is an independent project. It is not affiliated with, endorsed by, or sponsored by Okta, Google, or Anthropic.

## How it works

1. You type a request. The text (and nothing else) is sent to the AI provider you configured
   (Google Gemini or Anthropic Claude) to produce a read-only Okta API request.
2. The request is validated locally against a read-only allowlist of paths, parameters, and operators. You can edit it.
3. The extension calls your own Okta org's Admin API with a GET, using your open admin session.
4. Results are shown in a table and can be exported to CSV or JSON. Okta data is never sent to the AI provider.

## Install (developer mode)

1. Clone this repository.
2. Open `chrome://extensions`, enable Developer mode, click "Load unpacked" and select the `extension/` folder.
3. Open the extension options and add your API key (a free Google AI Studio key works with Gemini).
4. Open your Okta Admin Console (`*-admin.okta.com`) and use the AiT.KO button in the bottom-right corner.

## Privacy

See the [privacy policy](https://iamcandido.github.io/ait-ko/privacy.html).

## Notes

- The API key is stored in `chrome.storage.local`, which is not encrypted at rest. Use a dedicated, revocable key.
- Only HTTP GET requests are made against Okta, and only to allowlisted resources: users, groups, apps, system log, policies,
  authorization servers, IdPs, network zones, hooks, trusted origins, devices, domains, org and schemas.
- Fields that look like secrets (client secrets, passwords, API keys) are redacted from results and exports.
- Looking up members of a group or users of an app needs the object's id; ask for the list first, then use the id.

## License

MIT, see [LICENSE](LICENSE).