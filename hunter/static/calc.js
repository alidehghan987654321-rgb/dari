/* The import calculator's arithmetic: the same formulas as hunter/pricing.py (a test
   runs both on the same inputs), plus what a seller plans with: volumetric weight, a
   price of their own, the first shipment, and months to get the money back.
   Works in the browser (window.HunterCalc) and in node (require). */
(function (root) {
  "use strict";

  var VOLUMETRIC_DIVISOR = 6000; // cm³ per kg, the courier/air-freight standard
  var FREIGHT = { sea: 1.2, air: 5.0 }; // $/kg to Dubai, rough; the site's default sits between

  function charm(x) { return Math.ceil((x + 0.01) * 2) / 2 - 0.01; }
  function charmDown(x) { return Math.floor((x + 0.01) * 2) / 2 - 0.01; }
  function r2(x) { return Math.round(x * 100) / 100; }
  function r4(x) { return Math.round(x * 10000) / 10000; }

  function chargeableWeight(kg, dims) {
    var vol = dims && dims.l > 0 && dims.w > 0 && dims.h > 0 ? (dims.l * dims.w * dims.h) / VOLUMETRIC_DIVISOR : 0;
    return { actual: kg, volumetric: r2(vol), chargeable: Math.max(kg, vol) };
  }

  function lastMileFor(tiers, kg) {
    for (var i = 0; i < tiers.length; i++) {
      if (tiers[i][0] === null || kg <= tiers[i][0]) return tiers[i][1];
    }
    return tiers[tiers.length - 1][1];
  }

  // cfg: the site's pricing settings (/api/config "pricing"), snake_case like pricing.py.
  // input: what the seller typed; any cfg value can be overridden in input.cfg.
  function compute(input, siteCfg) {
    var cfg = Object.assign({}, siteCfg, input.cfg || {});
    if (input.market && cfg.returns_by_market && !(input.cfg && input.cfg.returns_pct != null)) {
      cfg.returns_pct = cfg.returns_by_market[input.market] || 0;
    }
    if (input.freight && FREIGHT[input.freight] && !(input.cfg && input.cfg.freight_usd_per_kg != null)) {
      cfg.freight_usd_per_kg = FREIGHT[input.freight];
    }
    var units = Math.max(1, input.units || 1);
    var priceCny = input.currency === "usd" ? input.price * cfg.cny_per_usd : input.price;
    var w = chargeableWeight(input.weight_kg, input.dims);
    var weight = w.chargeable;
    var cuts = cfg.platform_pct + cfg.gateway_pct + cfg.marketing_pct + cfg.returns_pct;
    var keep = 1 - cuts;
    var itemsPerCart = Math.max(1, input.items_per_cart || cfg.items_per_cart || 1);

    var factory = (priceCny * units) / cfg.cny_per_usd;
    var chinaSide = factory * cfg.china_side_pct;
    var freight = weight * cfg.freight_usd_per_kg;
    var landed = factory + chinaSide + freight + cfg.packaging_usd;
    var lastMile = lastMileFor(cfg.last_mile_usd, weight) / itemsPerCart;
    var unitCost = landed + lastMile;
    var out = {
      ok: keep - cfg.target_margin > 0.02,
      weight: w, cfg: cfg, keep: keep, unit_cost: unitCost, raw_landed: landed, raw_factory: factory,
      factory_usd: r2(factory), china_side_usd: r2(chinaSide), freight_usd: r2(freight),
      packaging_usd: r2(cfg.packaging_usd), landed_usd: r2(landed), last_mile_usd: r2(lastMile),
    };
    if (!out.ok) return out;

    var floor = unitCost / (keep - cfg.target_margin);
    var breakeven = unitCost / keep;
    var temu = input.temu_usd || null, amazon = input.amazon_usd || null;
    var benchmark = temu, estimated = false;
    if (!benchmark && amazon) { benchmark = amazon * cfg.temu_vs_amazon; estimated = true; }
    var price = charm(floor);
    if (benchmark) {
      var under = charmDown(benchmark * (1 - cfg.undercut));
      if (under >= floor) price = under;
    }
    Object.assign(out, at(out, price), {
      recommended_usd: r2(price), floor_usd: r2(floor), breakeven_usd: r2(breakeven),
      benchmark_usd: benchmark ? r2(benchmark) : null, benchmark_estimated: estimated,
      temu_usd: temu, amazon_usd: amazon,
    });
    out.vs_benchmark = benchmark ? r4(price / benchmark) : null;
    out.vs_amazon = amazon ? r4(price / amazon) : null;
    out.verdict = verdict(out.margin, out.vs_benchmark, cfg);
    return out;
  }

  // Everything that depends on the selling price, for the recommended or any other price.
  function at(base, price) {
    var cfg = base.cfg;
    var profit = price * base.keep - base.unit_cost;
    return {
      price_usd: r2(price),
      platform_fee_usd: r2(price * cfg.platform_pct),
      gateway_usd: r2(price * cfg.gateway_pct),
      marketing_usd: r2(price * cfg.marketing_pct),
      returns_reserve_usd: r2(price * cfg.returns_pct),
      profit_usd: r2(profit),
      margin: r4(profit / price),
      roi: r4(profit / (base.raw_landed || 1)),
      multiplier: base.raw_factory ? r2(price / base.raw_factory) : 0,
    };
  }

  function verdict(margin, vsBenchmark, cfg) {
    if (margin < 0.08 || (vsBenchmark != null && vsBenchmark > 1 + cfg.max_premium)) return "red";
    if (margin >= cfg.target_margin && (vsBenchmark == null || vsBenchmark <= 1.03)) return "green";
    return "yellow";
  }

  // The first shipment: what it costs, what it earns, and when the money is back. Each
  // sale brings back its landed cost plus its profit (what's left after fees and delivery),
  // so the capital is back before the last piece is sold.
  // licenseUsd: the store panel's licence still to pay from profits (0 when exempt).
  function shipment(res, qty, monthlySales, tomanPerUsd, licenseUsd) {
    var capital = qty * res.landed_usd;
    var perSale = res.landed_usd + res.profit_usd;
    var profit = qty * res.profit_usd;
    var unitsBack = perSale > 0 ? Math.ceil(capital / perSale - 1e-9) : null;
    if (unitsBack != null && unitsBack > qty) unitsBack = null;
    var monthly = monthlySales > 0 ? Math.min(monthlySales, qty) * res.profit_usd : null;
    var license = Math.max(0, licenseUsd || 0);
    var shelf = res.cfg && res.cfg.max_shelf_months;
    function toman(usd) { return tomanPerUsd && usd != null ? Math.round(usd * tomanPerUsd) : null; }
    function r1(x) { return Math.round(x * 10) / 10; }
    return {
      qty: qty, per_sale_usd: r2(perSale), capital_usd: r2(capital), revenue_usd: r2(qty * res.price_usd),
      profit_usd: r2(profit), monthly_profit_usd: monthly != null ? r2(monthly) : null,
      capital_toman: toman(capital), profit_toman: toman(profit), monthly_profit_toman: toman(monthly),
      units_to_cash_back: unitsBack,
      cash_back_months: unitsBack != null && monthlySales > 0 ? r1(unitsBack / monthlySales) : null,
      sell_out_months: monthlySales > 0 ? r1(qty / monthlySales) : null,
      // The contract: unsold stock older than max_shelf_months may be removed.
      shelf_months: shelf || null,
      over_shelf: !!(shelf && monthlySales > 0 && qty / monthlySales > shelf),
      max_qty_on_shelf: shelf && monthlySales > 0 ? Math.floor(monthlySales * shelf) : null,
      // The panel's licence, paid off from the monthly profit.
      license_usd: license,
      license_months: license && monthly > 0 ? r1(license / monthly) : null,
      first_year_usd: monthly != null ? r2(monthly * 12 - license) : null,
      first_year_toman: monthly != null ? toman(monthly * 12 - license) : null,
    };
  }

  // Where each dollar of the selling price goes, in five groups (for the chart).
  function split(res) {
    var buy = res.factory_usd + res.china_side_usd + res.packaging_usd;
    var ship = res.freight_usd + res.last_mile_usd;
    var other = res.gateway_usd + res.marketing_usd + res.returns_reserve_usd;
    return [
      { key: "profit", value: r2(res.profit_usd) },
      { key: "buy", value: r2(buy) },
      { key: "ship", value: r2(ship) },
      { key: "fee", value: r2(res.platform_fee_usd) },
      { key: "other", value: r2(other) },
    ];
  }

  var api = { compute: compute, at: at, shipment: shipment, split: split, verdict: verdict,
    chargeableWeight: chargeableWeight, charm: charm, charmDown: charmDown, FREIGHT: FREIGHT };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.HunterCalc = api;
})(typeof window !== "undefined" ? window : this);
