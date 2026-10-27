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
console.log('ALL TESTS PASSED');
