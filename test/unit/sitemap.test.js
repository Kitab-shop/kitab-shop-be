import assert from "node:assert/strict";
import test from "node:test";

import { buildRobotsTxt, resolveSiteUrl } from "../../src/modules/seo/sitemap.service.js";

// These read process.env directly, so each test sets and restores what it needs.
const withEnv = (vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("SITE_URL wins over FRONTEND_URL", () => {
  withEnv({ SITE_URL: "https://shop.example", FRONTEND_URL: "http://localhost:3000" }, () => {
    assert.equal(resolveSiteUrl(), "https://shop.example");
  });
});

test("FRONTEND_URL is the fallback", () => {
  withEnv({ SITE_URL: undefined, FRONTEND_URL: "https://fallback.example" }, () => {
    assert.equal(resolveSiteUrl(), "https://fallback.example");
  });
});

test("trailing slashes are stripped so joins cannot double up", () => {
  withEnv({ SITE_URL: "https://shop.example///" }, () => {
    assert.equal(resolveSiteUrl(), "https://shop.example");
  });
});

test("an unset origin resolves to an empty string", () => {
  withEnv({ SITE_URL: undefined, FRONTEND_URL: undefined }, () => {
    assert.equal(resolveSiteUrl(), "");
  });
});

test("robots.txt disallows the private and transactional areas", () => {
  withEnv({ SITE_URL: "https://shop.example" }, () => {
    const robots = buildRobotsTxt();

    for (const path of ["/admin", "/account", "/cart", "/checkout", "/login", "/signup"]) {
      assert.ok(robots.includes(`Disallow: ${path}`), `${path} should be disallowed`);
    }
    assert.ok(robots.includes("Allow: /"));
  });
});

test("robots.txt advertises the sitemap when an origin is configured", () => {
  withEnv({ SITE_URL: "https://shop.example" }, () => {
    assert.ok(buildRobotsTxt().includes("Sitemap: https://shop.example/api/v1/seo/sitemap.xml"));
  });
});

test("robots.txt omits the sitemap line when no origin is configured", () => {
  withEnv({ SITE_URL: undefined, FRONTEND_URL: undefined }, () => {
    const robots = buildRobotsTxt();

    assert.ok(!robots.includes("Sitemap:"), "a relative sitemap line would be invalid");
    assert.ok(robots.includes("User-agent: *"), "the rest of the file is still served");
  });
});
