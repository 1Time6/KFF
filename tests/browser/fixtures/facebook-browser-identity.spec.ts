import { test, expect } from '@playwright/test';
import { inspectFacebookProfileIdentity } from '../../../packages/adapters/src/facebook-browser-identity';

// The local fixture sets its resolved URL without a network redirect. The real /me/ redirect is verified separately.
// Minimal rendered DOM based on the selected account's observed Chinese UI. Never real-platform acceptance.
test('follows the current self profile and verifies its own controls without a home sidebar', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/*', route => {
    requests.push(route.request().method());
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<script>history.replaceState(null,"","/profile.php?id=1122")</script><main><h1>Local Profile</h1><button>编辑个人主页</button><div role="tab">好友</div></main>' });
  });
  expect(await inspectFacebookProfileIdentity(page, '1122')).toMatchObject({ operating_identity_id: '1122', account_type: 'profile', display_name: 'Local Profile', authenticated: true });
  expect(requests).toEqual(['GET']);
});
test('rejects another signed-in identity, login pages, ambiguous headings and non-own profiles', async ({ page }) => {
  let scenario = 'wrong';
  await page.route('**/*', route => {
    let body = '<main><h1>Other</h1><button>编辑个人主页</button><div role="tab">好友</div></main>';
    if (scenario === 'login') body = '<input type="password"><button>Log In</button>';
    if (scenario === 'duplicate') body = body.replace('<h1>Other</h1>', '<h1>Other</h1><h1>Ambiguous</h1>');
    if (scenario === 'not-own') body = '<main><h1>Other</h1><button>添加好友</button></main>';
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<script>history.replaceState(null,"","/profile.php?id=9999")</script>' + body });
  });
  await expect(inspectFacebookProfileIdentity(page, '1122')).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  scenario = 'login'; await expect(inspectFacebookProfileIdentity(page, '9999')).rejects.toMatchObject({ code: 'LOGIN_REQUIRED' });
  scenario = 'duplicate'; await expect(inspectFacebookProfileIdentity(page, '9999')).rejects.toMatchObject({ code: 'IDENTITY_UNVERIFIED' });
  scenario = 'not-own'; await expect(inspectFacebookProfileIdentity(page, '9999')).rejects.toMatchObject({ code: 'IDENTITY_UNVERIFIED' });
});
test('waits for the self-profile redirect and own controls to finish rendering', async ({ page }) => {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main></main><script>setTimeout(()=>history.replaceState(null,"","/profile.php?id=1122"),1000);setTimeout(()=>document.querySelector("main").innerHTML="<h1>Local Profile</h1><button>编辑个人主页</button><div role=tab>好友</div>",2500)</script>' }));
  expect(await inspectFacebookProfileIdentity(page, '1122')).toMatchObject({ operating_identity_id: '1122', authenticated: true });
});

const linkedProfile = (editId = '1122', timelineId = '1122', title = 'Local Profile', extra = '') =>
  '<script>history.replaceState(null,"","/profile.php?id=1122")</script><main>' +
  '<div role="button">' + title + '</div><div data-pagelet="ProfileActions"><a aria-label="编辑个人主页" href="/profile.php?id=' + editId + '&sk=about&fb_profile_edit_entry_point=%7B%22feature%22%3A%22profile_header%22%2C%22click_point%22%3A%22edit_profile_button%22%7D">编辑个人主页</a></div>' +
  '<div role="tab">好友</div><a href="/profile.php?id=' + timelineId + '" aria-label="Local Profile的时间线">Timeline</a>' + extra + '</main>';

test('verifies the linked editor and name button using the same profile timeline without clicking', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/*', route => {
    requests.push(route.request().method());
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: linkedProfile() });
  });
  expect(await inspectFacebookProfileIdentity(page, '1122')).toMatchObject({ operating_identity_id: '1122', display_name: 'Local Profile', authenticated: true });
  expect(requests).toEqual(['GET']);
});

test('rejects a different edit target, unrelated timeline, mismatched or ambiguous names in the new header', async ({ page }) => {
  let body = linkedProfile('9999');
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
  for (const variant of [linkedProfile('9999'), linkedProfile('1122', '9999'), linkedProfile('1122', '1122', 'Other'), linkedProfile('1122', '1122', 'Local Profile', '<div role="button">Local Profile</div>'), linkedProfile('1122', '1122', 'Local Profile', '<h1>One</h1><h1>Two</h1>'), linkedProfile().replace('aria-label="Local Profile的时间线"', '').replace('>Timeline<', '>Local Profile的时间线<')]) {
    body = variant;
    await expect(inspectFacebookProfileIdentity(page, '1122')).rejects.toMatchObject({ code: 'IDENTITY_UNVERIFIED' });
  }
});

test('does not accept a same-name button from the feed as the profile header', async ({ page }) => {
  const body = linkedProfile().replace('<div role="button">Local Profile</div>', '').replace('</main>', '<article><div role="button">Local Profile</div></article></main>');
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body }));
  await expect(inspectFacebookProfileIdentity(page, '1122')).rejects.toMatchObject({ code: 'IDENTITY_UNVERIFIED' });
});

const friendCountProfile = () => linkedProfile().replace('<div role="tab">好友</div>', '').replace('<div data-pagelet="ProfileActions">', '<a href="/profile.php?id=1122&sk=friends_all">1 位好友</a><div data-pagelet="ProfileActions">');

const buttonFriendCountProfile = () => '<script>history.replaceState(null,"","/profile.php?id=1122")</script><main><h1>Local Profile</h1><a href="/profile.php?id=1122&sk=friends">1 位好友</a><div data-pagelet="ProfileActions"><button>编辑个人主页</button></div></main>';

test('verifies the observed h1 and button editor header with its own friends link', async ({ page }) => {
  const methods: string[] = [];
  await page.route('**/*', route => { methods.push(route.request().method()); return route.fulfill({ contentType: 'text/html; charset=utf-8', body: buttonFriendCountProfile() }); });
  expect(await inspectFacebookProfileIdentity(page, '1122')).toMatchObject({ operating_identity_id: '1122', account_type: 'profile', display_name: 'Local Profile' });
  expect(methods).toEqual(['GET']);
});

for (const [scenario, mutate] of Object.entries({
  'another profile': (body: string) => body.replace('id=1122&sk=friends', 'id=9999&sk=friends'),
  'followers route': (body: string) => body.replace('sk=friends', 'sk=followers'),
  'missing own action region': (body: string) => body.replace('data-pagelet="ProfileActions"', ''),
  'feed-only friend count': (body: string) => body.replace('<a href="/profile.php?id=1122&sk=friends">1 位好友</a>', '').replace('</main>', '<article><a href="/profile.php?id=1122&sk=friends">1 位好友</a></article></main>'),
  'duplicate friend count': (body: string) => body.replace('1 位好友</a>', '1 位好友</a><a href="/profile.php?id=1122&sk=friends">1 位好友</a>'),
  'untrusted origin': (body: string) => body.replace('href="/profile.php?id=1122&sk=friends"', 'href="https://example.com/profile.php?id=1122&sk=friends"'),
})) {
  test('rejects button editor friend count with ' + scenario, async ({ page }) => {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: mutate(buttonFriendCountProfile()) }));
    await expect(inspectFacebookProfileIdentity(page, '1122')).rejects.toMatchObject({ code: 'IDENTITY_UNVERIFIED' });
  });
}

test('accepts the observed own-header friend count link without opening it', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/*', route => { requests.push(route.request().method()); return route.fulfill({ contentType: 'text/html; charset=utf-8', body: friendCountProfile() }); });
  expect(await inspectFacebookProfileIdentity(page, '1122')).toMatchObject({ operating_identity_id: '1122', account_type: 'profile', display_name: 'Local Profile' });
  expect(requests).toEqual(['GET']);
});

for (const [scenario, mutate] of Object.entries({
  'another profile': (body: string) => body.replace('id=1122&sk=friends_all', 'id=9999&sk=friends_all'),
  'followers instead of friends': (body: string) => body.replace('sk=friends_all', 'sk=followers'),
  'duplicate friend count': (body: string) => body.replace('1 位好友</a>', '1 位好友</a><a href="/profile.php?id=1122&sk=friends_all">1 位好友</a>'),
  'feed friend count': (body: string) => body.replace('<a href="/profile.php?id=1122&sk=friends_all">1 位好友</a>', '').replace('</main>', '<article><a href="/profile.php?id=1122&sk=friends_all">1 位好友</a></article></main>'),
  'friend count before the title': (body: string) => body.replace('<a href="/profile.php?id=1122&sk=friends_all">1 位好友</a>', '').replace('<main>', '<main><a href="/profile.php?id=1122&sk=friends_all">1 位好友</a>'),
  'untrusted origin': (body: string) => body.replace('href="/profile.php?id=1122&sk=friends_all"', 'href="https://example.com/profile.php?id=1122&sk=friends_all"'),
})) {
  test('rejects own-header friend count with ' + scenario, async ({ page }) => {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: mutate(friendCountProfile()) }));
    await expect(inspectFacebookProfileIdentity(page, '1122')).rejects.toMatchObject({ code: 'IDENTITY_UNVERIFIED' });
  });
}
