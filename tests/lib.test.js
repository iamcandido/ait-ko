const assert = require('assert');
const L = require('../extension/lib.js');
const O = 'https://acme-admin.okta.com';
const ok  = (raw) => { const r = L.buildRequest(raw, O); assert(r.url, `should accept: ${raw} -> ${r.error}`); return r; };
const bad = (raw) => { const r = L.buildRequest(raw, O); assert(r.error, `should reject: ${raw}`); };

// accepted
ok('/api/v1/users?search=status eq "ACTIVE" and profile.department eq "Finance" and profile.countryCode eq "PT"');
ok('/api/v1/groups?q=finance');
ok('/api/v1/groups/00g1abc/users');
ok('/api/v1/apps?filter=status eq "ACTIVE"');
ok('/api/v1/logs?since=2026-10-22T00:00:00.000Z&filter=eventType eq "user.session.start" and outcome.result eq "FAILURE"');
ok('/api/v1/policies?type=OKTA_SIGN_ON');
ok('/api/v1/users/jane.doe@example.com/groups');

// rejected: writes / lifecycle / unknown paths
bad('/api/v1/users/00u1/lifecycle/deactivate');
bad('/api/v1/users/00u1/lifecycle');
bad('/api/v1/users/00u1/credentials/forgot_password');
bad('/api/v1/sessions/me');
bad('/oauth2/v1/token');
bad('/api/v1/users/../../api/v1/sessions');
bad('/api/v1/users/%2e%2e/%2e%2e/x');
bad('https://evil.example/api/v1/users');
bad('//evil.example/api/v1/users');
// rejected: params and expressions
bad('/api/v1/users?after=abc');
bad('/api/v1/users?activate=true');
bad('/api/v1/users?search=status eq "ACTIVE"; DROP');
bad('/api/v1/users?search=status eq "ACTIVE');
bad('/api/v1/users?search=status eq \'ACTIVE\'');
bad('/api/v1/users?q=a&q=b');
bad('/api/v1/logs?since=yesterday');

// limit handling
assert(ok('/api/v1/users').url.includes('limit=200'));
assert(ok('/api/v1/users?limit=1000').url.includes('limit=200'));
assert(ok('/api/v1/users?limit=25').url.includes('limit=25'));

assert.strictEqual(ok('/api/v1/users').display, '/api/v1/users', 'default limit is not shown');
assert(ok('/api/v1/users?limit=25').display.includes('limit=25'), 'custom limit is shown');
// display round-trips even with & in values
bad('/api/v1/users?search=profile.department eq "R&D"'); // raw & splits the query: rejected, never misread
const r = ok('/api/v1/users?search=profile.department eq "R%26D"');
const again = L.buildRequest(r.display, O);
assert.strictEqual(again.url, r.url, 'display must round-trip');
assert(r.display.includes('R%26D'));

// next link: relative, /api/v1 only
assert.strictEqual(L.nextLink('<https://acme.okta.com/api/v1/users?after=1&limit=200>; rel="next"'), '/api/v1/users?after=1&limit=200');
assert.strictEqual(L.nextLink('<https://acme.okta.com/api/v1/users?limit=200>; rel="self", <https://acme.okta.com/api/v1/users?after=2>; rel="next"'), '/api/v1/users?after=2');
assert.strictEqual(L.nextLink('<https://acme.okta.com/oauth2/x>; rel="next"'), null);
assert.strictEqual(L.nextLink('<https://acme.okta.com/api/v1/users>; rel="self"'), null);
assert.strictEqual(L.nextLink(null), null);

// redaction
const red = L.redact([{ label: 'x', credentials: { oauthClient: { client_id: 'abc', client_secret: 'S3CR3T' } }, settings: { app: { apiKey: 'K', url: 'u' } }, credentials2: { password: { value: 'p' } }, active: true }]);
const s = JSON.stringify(red);
assert(!s.includes('S3CR3T') && !s.includes('"K"') && !s.includes('"p"'), s);
assert(s.includes('abc') && s.includes('"u"'));

// helpers
assert.strictEqual(L.getPath({ a: { b: 1 } }, 'a.b'), 1);
assert.strictEqual(L.getPath({ a: null }, 'a.b'), undefined);
assert.strictEqual(L.show({ x: 1 }), '{"x":1}');
assert.strictEqual(L.csvEscape('=1+1'), "'=1+1");
assert.strictEqual(L.csvEscape('a,b'), '"a,b"');
assert.deepStrictEqual(L.autoColumns([{ id: '1', profile: {}, status: 'A' }]), ['id', 'status']);
// "ne" is rewritten to lt/gt for user search (Okta has no ne), without touching quoted values
const ne = ok('/api/v1/users?search=status eq "ACTIVE" and profile.countryCode ne "PT"');
assert(ne.display.includes('(profile.countryCode lt "PT" or profile.countryCode gt "PT")'), ne.display);
assert(!/ ne /.test(ne.display), ne.display);
assert.strictEqual(L.rewriteNe('profile.x eq "a ne b"'), 'profile.x eq "a ne b"');
assert.strictEqual(L.rewriteNe('profile.department ne "R&D" and status eq "ACTIVE"'), '(profile.department lt "R&D" or profile.department gt "R&D") and status eq "ACTIVE"');
assert(L.buildRequest(ne.display, O).url, 'rewritten expression still validates and round-trips');
assert(ok('/api/v1/logs?since=2026-10-22&filter=outcome.result ne "SUCCESS"').display.includes('ne "SUCCESS"'), 'ne untouched outside user search');
// ---- local filters ----
assert.deepStrictEqual(L.parseLocalFilters(null), { filters: [] });
assert.deepStrictEqual(L.parseLocalFilters([{ path: 'profile.countryCode', op: 'empty' }]).filters, [{ path: 'profile.countryCode', op: 'empty' }]);
assert(L.parseLocalFilters([{ path: 'profile.x', op: 'ne' }]).error, 'ne needs a value');
assert(L.parseLocalFilters([{ path: 'profile.x', op: 'regex', value: 'a' }]).error, 'unknown op');
assert(L.parseLocalFilters([{ path: 'profile x', op: 'empty' }]).error, 'bad path');
assert(L.parseLocalFilters('x').error, 'not a list');
assert(L.parseLocalFilters(Array(6).fill({ path: 'a', op: 'empty' })).error, 'too many');
const u = (cc) => ({ id: cc || 'none', profile: { countryCode: cc } });
const E = [{ path: 'profile.countryCode', op: 'empty' }];
assert(L.matchesLocal(u(undefined), E) && L.matchesLocal(u(null), E) && L.matchesLocal(u(''), E) && L.matchesLocal(u('  '), E));
assert(!L.matchesLocal(u('PT'), E));
const NE = [{ path: 'profile.countryCode', op: 'ne', value: 'pt' }];
assert(!L.matchesLocal(u('PT'), NE), 'case-insensitive');
assert(L.matchesLocal(u('ES'), NE) && L.matchesLocal(u(undefined), NE), 'empty counts as not equal');
assert(L.matchesLocal({ profile: { title: 'Senior Dev' } }, [{ path: 'profile.title', op: 'co', value: 'dev' }]));
assert(L.matchesLocal({ profile: { title: 'Senior Dev' } }, [{ path: 'profile.title', op: 'nco', value: 'manager' }]));
assert(L.matchesLocal({ profile: { title: 'Senior Dev' } }, [{ path: 'profile.title', op: 'sw', value: 'sen' }]));
assert.strictEqual(L.describeLocal(E), 'profile.countryCode is empty');
assert.strictEqual(L.describeLocal(NE), 'profile.countryCode is not "pt"');
// ---- multi-step plans ----
const PS = plan => L.parseSteps(plan, O);
const appPlan = () => ({ steps: [
  { name: 'app', request: '/api/v1/apps?q=Okta Admin Console', pick: true, columns: ['id', 'label'] },
  { request: '/api/v1/apps/{{app.id}}/users?expand=user', columns: ['_embedded.user.profile.email', 'bad col!', 5] }
] });
let ps = PS(appPlan());
assert(!ps.error, ps.error);
assert.strictEqual(ps.steps.length, 2);
assert.strictEqual(ps.steps[0].pick, true);
assert.strictEqual(ps.steps[1].columns.join(), '_embedded.user.profile.email', 'invalid column names are dropped');
// a single request still works, in the old format
ps = PS({ request: '/api/v1/users?q=ana', local_filter: [{ path: 'profile.countryCode', op: 'empty' }], columns: ['id'] });
assert(!ps.error && ps.steps.length === 1 && ps.steps[0].localFilters.length === 1);
assert(PS({}).error && PS({ request: '' }).error && PS(null).error && PS({ steps: [] }).error);
// structural rules
const withStep = (i, patch) => { const x = appPlan(); Object.assign(x.steps[i], patch); return x; };
assert(PS({ steps: Array(5).fill({ name: 'a', request: '/api/v1/users' }) }).error, 'too many steps');
assert(/needs a name/.test(PS({ steps: [{ request: '/api/v1/apps' }, { request: '/api/v1/users' }] }).error), 'earlier steps need a name');
assert(/last step cannot/.test(PS({ steps: [{ name: 'a', request: '/api/v1/apps' }, { request: '/api/v1/apps/{{a.id}}/users', pick: true }] }).error));
assert(/invalid or repeated/.test(PS({ steps: [{ name: 'a', request: '/api/v1/apps' }, { name: 'a', request: '/api/v1/groups' }, { request: '/api/v1/users' }] }).error));
assert(/invalid or repeated/.test(PS(withStep(0, { name: 'row' })).error), '"row" is reserved');
assert(/invalid or repeated/.test(PS(withStep(0, { name: 'Bad Name' })).error));
assert(/not an earlier "pick" step/.test(PS(withStep(0, { pick: false })).error), 'placeholder needs a pick step');
assert(/not an earlier "pick" step/.test(PS(withStep(1, { request: '/api/v1/apps/{{nope.id}}/users' })).error));
assert(/without "for_each"/.test(PS(withStep(1, { request: '/api/v1/apps/{{row.id}}/users' })).error));
assert(/malformed placeholder/.test(PS(withStep(1, { request: '/api/v1/apps/{{app}}/users' })).error));
assert(/malformed placeholder/.test(PS(withStep(1, { request: '/api/v1/apps/{{app.id/users' })).error));
const fe = (patch) => ({ steps: [{ name: 'g', request: '/api/v1/groups?q=fin' }, Object.assign({ for_each: 'g', request: '/api/v1/groups/{{row.id}}/users' }, patch)] });
assert(!PS(fe({})).error, 'valid for_each plan');
assert(/needs \{\{row/.test(PS(fe({ request: '/api/v1/users' })).error), 'for_each without {{row.}}');
assert(/must name an earlier step/.test(PS(fe({ for_each: 'zzz' })).error));
assert(/must name an earlier step/.test(PS({ steps: [{ name: 'g', request: '/api/v1/groups', pick: true }, { for_each: 'g', request: '/api/v1/groups/{{row.id}}/users' }] }).error), 'cannot iterate a pick step');
assert(/both/.test(PS({ steps: [{ name: 'g', request: '/api/v1/groups' }, { name: 'h', pick: true, for_each: 'g', request: '/api/v1/groups/{{row.id}}/users' }, { request: '/api/v1/users' }] }).error));
// every step must pass the read-only allowlist, even with placeholders
assert(/allowlist/.test(PS({ steps: [{ name: 'u', request: '/api/v1/users?q=ana', pick: true }, { request: '/api/v1/users/{{u.id}}/lifecycle/deactivate' }] }).error), 'no writes through placeholders');
assert(PS({ steps: [{ name: 'u', request: '/api/v1/users?q=ana', pick: true }, { request: '/api/v1/users/{{u.id}}/groups' }] }).steps, 'allowed sub-resource');
assert(/Step 2/.test(PS(withStep(1, { request: '/api/v1/sessions/{{app.id}}' })).error), 'errors say which step');
assert(PS({ steps: [{ name: 'a', request: '/api/v1/apps?q=x&after=1', pick: true }, { request: '/api/v1/apps/{{a.id}}/users' }] }).error, 'parameter allowlist applies to every step');

// fillPlaceholders: only id-like values may reach a URL
const row = { id: '0oa1B2c3', label: 'Okta Admin Console', n: { id: '00u9' }, bad: '../../x', slash: 'a/b', q: 'a?b=1', empty: '', obj: { x: 1 }, dots: '..', mail: 'a.b+c@x.com' };
assert.strictEqual(L.fillPlaceholders('/api/v1/apps/{{app.id}}/users', { app: row }).request, '/api/v1/apps/0oa1B2c3/users');
assert.strictEqual(L.fillPlaceholders('/api/v1/apps/{{ app.n.id }}/users', { app: row }).request, '/api/v1/apps/00u9/users');
assert.strictEqual(L.fillPlaceholders('/api/v1/users/{{row.mail}}/groups', { row }).request, '/api/v1/users/a.b+c@x.com/groups');
for (const f of ['bad', 'slash', 'q', 'empty', 'obj', 'dots', 'missing']) assert(L.fillPlaceholders(`/api/v1/apps/{{app.${f}}}/users`, { app: row }).error, 'rejects ' + f);
assert(L.fillPlaceholders('/api/v1/apps/{{ghost.id}}/users', { app: row }).error, 'unknown step');
assert(L.fillPlaceholders('/api/v1/apps/{{app.id}}/users', { constructor: row }).error, 'no prototype lookups');
assert(L.fillPlaceholders('/api/v1/apps/{{toString.id}}/users', {}).error, 'no prototype lookups (2)');
assert(L.fillPlaceholders('{{a.id}}/{{a.bad}}', { a: row }).error, 'one bad value fails the whole request');
// the filled request still goes through the full validation
assert(L.buildRequest(L.fillPlaceholders('/api/v1/apps/{{app.id}}/users?expand=user', { app: row }).request, O).url);

const desc = L.describeSteps(PS(fe({})).steps);
assert(/^1\. \/api\/v1\/groups\?q=fin/.test(desc[0]) && /once for each result of "g"/.test(desc[1]), desc.join('|'));
assert(/you choose one result/.test(L.describeSteps(PS(appPlan()).steps)[0]));
console.log('ALL TESTS PASSED');
