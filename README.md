# AiT.KO

Natural-language user queries for the Okta Admin Console. Describe a search in plain language
(for example "active users in the Finance department with countryCode PT"), review the generated
Okta search filter, run it with your existing admin session (no API token), and export the results to CSV.

AiT.KO is an independent project. It is not affiliated with, endorsed by, or sponsored by Okta, Google, or Anthropic.

## How it works

1. You type a request. The text (and nothing else) is sent to the AI provider you configured
   (Google Gemini or Anthropic Claude) to produce an Okta `search` filter.
2. The filter is validated locally: read-only, known attributes and operators only. You can edit it.
3. The extension calls your own Okta org's `/api/v1/users` endpoint using your open admin session.
4. Results are shown in a table and can be exported to CSV. Okta user data is never sent to the AI provider.

## Install (developer mode)

1. Clone this repository.
2. Open `chrome://extensions`, enable Developer mode, click "Load unpacked" and select the `extension/` folder.
3. Open the extension options and add your API key (a free Google AI Studio key works with Gemini).
4. Open your Okta Admin Console (`*-admin.okta.com`) and use the AiT.KO button in the bottom-right corner.

## Privacy

See the [privacy policy](https://iamcandido.github.io/ait-ko/privacy.html).

## Notes

- The API key is stored in `chrome.storage.local`, which is not encrypted at rest. Use a dedicated, revocable key.
- Only HTTP GET requests are made against Okta.

## License

MIT, see [LICENSE](LICENSE).
