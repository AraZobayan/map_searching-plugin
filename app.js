/* 沿线找店 —— A→B 公交换乘方案与候选站
 *
 * 数据流：地址补全（AutoComplete）→ 从补全 tip 取城市与坐标
 *        → AMap.Transfer 规划（policy 最快捷）→ 取回全部方案
 *        → 合并所有方案的地铁/公交站点并去重 → 画路线 + 站点 marker
 *
 * 约定（见 docs/decisions-metro-poi-map.md）：
 * - 不写死城市，城市信息来自补全结果（adcode / district）；
 * - 列表不显示价格；店铺详情卡按 D27 显示评分/人均/照片等详情；
 * - 每次新查询先清掉上一次的路线与 marker；
 * - 只做同城规划（D22）。
 */
(function () {
  'use strict';

  // 多方案路线配色（方案 1 最醒目）
  var ROUTE_COLORS = ['#2563eb', '#ea580c', '#059669', '#7c3aed', '#0891b2'];
  // setFitView 的留白：上、右、下、左
  var FIT_PADDING = [40, 60, 40, 40];
  var ROLE_LABEL = { transfer: '换乘站', stop: '上下车站', via: '途经站' };
  var POI_CATEGORIES = ['酒店', '旅馆', '超市', '按摩', '美食'];
  var POI_TYPE_CODES = { 酒店: '100000', 旅馆: '100000', 超市: '060400', 按摩: '090000', 美食: '050000' };
  var POI_CATEGORY_CLASS = { 酒店: 'hotel', 旅馆: 'inn', 超市: 'market', 按摩: 'massage', 美食: 'food' };

  var state = {
    AMap: null,
    map: null,
    autos: {},            // 每个输入框一个 AutoComplete 实例（用于程序化补全）
    tips: { origin: null, dest: null }, // 用户从下拉列表选中的 tip
    infoWindow: null,
    overlays: [],         // 本次查询画上去的所有覆盖物，便于一次清空
    stations: [],         // 当前选中方案经过的站点
    plans: [],            // 高德返回的全部方案
    origin: null,         // 本次查询起点（用于重画）
    dest: null,           // 本次查询终点
    lineStations: {},     // 当前选中方案的线路名 → 整条线有序站序列（用于区间截取）
    lineLoading: false,   // 选中方案后正在加载线路站序列
    planLoadToken: 0,     // 防止快速切换方案时旧请求覆盖新结果
    selectedPlanIndex: -1, // 当前选中的方案下标，-1 表示未选
    busy: false,
    debug: {},            // 调试面板用的统计信息
    routePoints: [],      // 本次画到地图上的所有坐标，用于手动算 bounds
    rawResult: null,      // Transfer 原始返回，供调试区展示
    rawJsonText: '',      // 原始返回的 JSON 文本（截断到 8000 字符）
    lineCache: {},        // 途经站来源缓存：城市|线路名 → 结果
    lastQuery: null,      // 上次查询的城市/线路/路线上下文，供调试区「测试途经站来源」用
    // ---- 查周边（POI）----
    poiActive: false,     // 是否已进入「查周边」阶段（画整条线）
    poiDrawerOpen: false, // 「查周边」抽屉是否展开（入口在结果面板顶部常驻）
    poiLoading: false,    // 正在查周边
    poiCategories: ['酒店'], // 选中的品类，默认只勾酒店
    poiRadius: 800,       // 直线半径（米）
    poiStations: [],      // 整条线的全部站点（POI 阶段）
    poiQueried: {},       // 已查过的站点 key
    poiShops: {},         // 去重后的店：id → shop
    poiCache: {},         // 城市|站点|品类|半径 → 结果
    poiKeyStations: [],   // 本次自动查询的关键站
    poiOverlays: [],      // 店铺 marker
    poiLineOverlays: [],  // 整条线叠加层（线 + 站点）
    poiQueryToken: 0,
    shopCardShop: null,   // 当前详情卡对应的店
    shopCardCopyText: '', // 「复制店名」的内容（城市 + 店名）
  };

  var els = {};

  // ---------------------------------------------------------------- 小工具

  function $(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function userError(message) {
    var err = new Error(message);
    err.userFacing = true;
    return err;
  }

  function messageOf(err) {
    return (err && err.message) || String(err);
  }

  function setStatus(text) {
    if (!els.status) return;
    if (!text) {
      els.status.hidden = true;
      els.status.textContent = '';
      return;
    }
    els.status.hidden = false;
    els.status.textContent = text;
  }

  function showNotice(text) {
    els.notice.hidden = false;
    els.notice.textContent = text;
  }

  function clearNotice() {
    els.notice.hidden = true;
    els.notice.textContent = '';
  }

  function failMap(message) {
    setStatus('');
    els.errorText.textContent = String(message);
    els.error.classList.add('show');
  }

  function formatDistance(meters) {
    var m = Number(meters) || 0;
    if (m >= 1000) return (m / 1000).toFixed(1) + ' 公里';
    return Math.round(m) + ' 米';
  }

  // 高德返回的坐标可能是 LngLat、[lng, lat]、"lng,lat" 字符串或 {lng, lat}
  function toLngLat(loc) {
    var AMap = state.AMap;
    if (!loc || !AMap) return null;
    if (loc instanceof AMap.LngLat) return loc;
    if (typeof loc === 'string') {
      var parts = loc.split(',');
      if (parts.length === 2 && isFinite(Number(parts[0])) && isFinite(Number(parts[1]))) {
        return new AMap.LngLat(Number(parts[0]), Number(parts[1]));
      }
      return null;
    }
    if (Array.isArray(loc) && loc.length >= 2) {
      var lng = Number(loc[0]);
      var lat = Number(loc[1]);
      if (isFinite(lng) && isFinite(lat)) return new AMap.LngLat(lng, lat);
      return null;
    }
    if (typeof loc.getLng === 'function' && typeof loc.getLat === 'function') {
      return new AMap.LngLat(loc.getLng(), loc.getLat());
    }
    if (typeof loc.lng === 'number' && typeof loc.lat === 'number') {
      return new AMap.LngLat(loc.lng, loc.lat);
    }
    return null;
  }

  // ------------------------------------------------------------ 城市信息

  // 从补全结果的 district（如「广东省深圳市南山区」「北京市朝阳区」）里取城市名
  function cityNameFromDistrict(district) {
    var text = String(district || '').trim();
    if (!text) return '';
    // 省 / 自治区 / 特别行政区 之后的那一段才是城市
    var match = text.match(/(?:省|自治区|特别行政区)([^省市州盟]+[市州盟])/);
    if (match) return match[1];
    match = text.match(/^([^省市州盟]+[市州盟])/);
    if (match) return match[1];
    return '';
  }

  // 城市参数候选：城市名优先，adcode 兜底。两者都来自 tip，不写死任何城市。
  function cityFromTip(tip) {
    if (!tip) return null;
    var name = cityNameFromDistrict(tip.district);
    var adcode = tip.adcode ? String(tip.adcode) : '';
    var candidates = [];
    if (name) candidates.push(name);
    if (adcode && candidates.indexOf(adcode) < 0) candidates.push(adcode);
    if (!candidates.length) return null;
    return { candidates: candidates, label: name || adcode, name: name, adcode: adcode };
  }

  function sameCity(a, b) {
    if (a.city.name && b.city.name) return a.city.name === b.city.name;
    if (a.city.adcode && b.city.adcode) return a.city.adcode.slice(0, 4) === b.city.adcode.slice(0, 4);
    return true; // 城市信息不足时不拦，交给 Transfer 自己判断
  }

  // ------------------------------------------------------------ 地址解析

  function searchTips(key, keyword) {
    return new Promise(function (resolve, reject) {
      var auto = state.autos[key];
      if (!auto) {
        reject(userError('地址补全插件没加载成功，请刷新页面重试。'));
        return;
      }
      auto.search(keyword, function (status, result) {
        if (status === 'complete' && result && result.tips && result.tips.length) {
          resolve(result.tips);
          return;
        }
        if (status === 'error') {
          var info = (result && (result.info || result)) || '高德服务没有返回原因';
          reject(userError('地址补全失败：' + info + '。检查网络后重试。'));
          return;
        }
        resolve([]);
      });
    });
  }

  function lookupPoi(keyword, city) {
    return new Promise(function (resolve, reject) {
      var AMap = state.AMap;
      if (!AMap.PlaceSearch) {
        reject(userError('地点搜索插件没加载成功，请刷新页面重试。'));
        return;
      }
      var placeSearch = new AMap.PlaceSearch({
        city: city.candidates[0],
        pageSize: 1,
        extensions: 'base',
      });
      placeSearch.search(keyword, function (status, result) {
        var pois = status === 'complete' && result && result.poiList && result.poiList.pois;
        var poi = pois && pois[0];
        var ll = poi && toLngLat(poi.location);
        if (!ll) {
          reject(userError('无法解析「' + keyword + '」的坐标，请从补全下拉列表里重新选一个具体地点。'));
          return;
        }
        resolve({ name: poi.name || keyword, lng: ll.getLng(), lat: ll.getLat() });
      });
    });
  }

  // tip → 起终点（名称、坐标、城市参数）
  function placeFromTip(tip) {
    var city = cityFromTip(tip);
    if (!city) {
      return Promise.reject(userError('补全结果里没有城市信息（adcode / district 都为空），请从下拉列表里重新选一个具体地点。'));
    }
    var ll = toLngLat(tip.location);
    if (ll) {
      return Promise.resolve({ name: tip.name, lng: ll.getLng(), lat: ll.getLat(), city: city });
    }
    // 有些 tip 不带坐标，用 PlaceSearch 补一次
    return lookupPoi(tip.name, city).then(function (poi) {
      return { name: poi.name || tip.name, lng: poi.lng, lat: poi.lat, city: city };
    });
  }

  function resolvePlace(key) {
    var input = key === 'origin' ? els.originInput : els.destInput;
    var label = key === 'origin' ? '起点' : '终点';
    var text = (input.value || '').trim();
    if (!text) return Promise.reject(userError('请先填写' + label + '。'));

    var tip = state.tips[key];
    if (tip && tip.name !== text) {
      // 用户改了输入框内容，之前选中的 tip 作废
      tip = state.tips[key] = null;
    }
    if (tip) return placeFromTip(tip);

    // 用户没从下拉列表里选、直接点了查询：自己跑一次补全，取第一条
    return searchTips(key, text).then(function (tips) {
      if (!tips.length) {
        throw userError('地址补全没有结果：找不到「' + text + '」。换一个更具体的名称试试，比如加上城市名或「地铁站」。');
      }
      var usable = tips.filter(function (item) { return cityFromTip(item); })[0] || tips[0];
      return placeFromTip(usable);
    });
  }

  // ------------------------------------------------------------ 换乘规划

  function noPlanError() {
    return userError('高德没有返回公交/地铁方案。可能是起终点太近（步行就能到）、其中一端附近没有公交站，或该城市暂不支持公交换乘规划。');
  }

  function runTransfer(origin, dest) {
    var AMap = state.AMap;
    if (!AMap.Transfer) {
      return Promise.reject(userError('公交换乘插件没加载成功，请刷新页面重试。'));
    }
    // Transfer 只接受一个 city；城市名与 adcode 都来自 tip，失败时依次换下一个候选
    var candidates = [];
    origin.city.candidates.concat(dest.city.candidates).forEach(function (city) {
      if (candidates.indexOf(city) < 0) candidates.push(city);
    });
    var policy = AMap.TransferPolicy ? AMap.TransferPolicy.LEAST_TIME : 0; // 最快捷

    var index = 0;
    function attempt() {
      var city = candidates[index];
      return new Promise(function (resolve, reject) {
        var transfer = new AMap.Transfer({
          city: city,
          policy: policy,
          nightflag: false,
          extensions: 'all',
        });
        transfer.search(
          new AMap.LngLat(origin.lng, origin.lat),
          new AMap.LngLat(dest.lng, dest.lat),
          function (status, result) {
            var plans = (status === 'complete' && result && result.plans) || [];
            if (plans.length) {
              // 原始 result 一并带回，调试区要展示它的完整结构
              resolve({ plans: plans, city: city, raw: result });
              return;
            }
            if (status === 'no_data' || status === 'complete') {
              reject(noPlanError());
              return;
            }
            // 城市参数可能不被接受：换下一个候选再试一次
            if (status === 'error' && index < candidates.length - 1) {
              index += 1;
              attempt().then(resolve, reject);
              return;
            }
            var info = (result && (result.info || result)) || '高德服务没有返回原因';
            reject(userError('公交换乘规划失败：' + info + '。换个更具体的起终点试试。'));
          }
        );
      });
    }
    return attempt();
  }

  // ------------------------------------------------------- 站点合并与去重

  function normalizeStop(stop) {
    if (!stop) return null;
    // 兼容两种形态：带 location 的原始站，和已归一化的 {lng,lat} 站
    var ll = toLngLat(stop.location) || toLngLat(stop);
    if (!ll) return null;
    return {
      name: stop.name || '未命名站点',
      id: stop.id ? String(stop.id) : '',
      lng: ll.getLng(),
      lat: ll.getLat(),
    };
  }

  // 同一个站可能一次带 id、一次只有坐标，所以两种键都要认
  function stationKeys(stop) {
    var keys = [];
    if (stop.id) keys.push('id:' + stop.id);
    keys.push('ll:' + stop.lng.toFixed(6) + ',' + stop.lat.toFixed(6));
    return keys;
  }

  function sameStation(a, b) {
    if (!a || !b) return false;
    if (a.id && b.id && a.id === b.id) return true;
    return Math.abs(a.lng - b.lng) < 1e-6 && Math.abs(a.lat - b.lat) < 1e-6;
  }

  // -------------------------------------------------- 解析 Transfer 段（2.0 真实结构优先）

  // 旧结构兼容用：判断一个对象像不像「公交线路」
  function isBuslineLike(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var hasStops = !!(value.departure_stop || value.arrival_stop || value.via_stops);
    if (!hasStops) return false;
    return !!(value.name || value.type || value.id ||
      value.path !== undefined || value.polyline !== undefined || value.distance !== undefined);
  }

  // 数组、类数组对象、单个对象都转成数组
  function toArrayLike(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'object') {
      if (isBuslineLike(value)) return [value];
      return Object.keys(value).map(function (key) { return value[key]; });
    }
    return [];
  }

  function readBuslines(value) {
    return toArrayLike(value).filter(isBuslineLike);
  }

  function planSegments(plan) {
    if (!plan || typeof plan !== 'object') return [];
    var segments = plan.segments;
    if (!segments) return [];
    if (Array.isArray(segments)) return segments;
    if (segments.walking || segments.transit || segments.transit_mode) return [segments];
    return toArrayLike(segments);
  }

  // 段类型：2.0 真实结构在 segment.transit_mode（WALK / SUBWAY / BUS）
  function segmentMode(segment) {
    if (!segment || typeof segment !== 'object') return '';
    var mode = String(segment.transit_mode || '').toUpperCase();
    if (mode) return mode;
    if (segment.walking) return 'WALK';
    if (segment.transit && (segment.transit.on_station || segment.transit.off_station)) return 'TRANSIT';
    if (segment.transit && (segment.transit.buslines || segment.buslines)) return 'BUS';
    return '';
  }

  function segmentTransit(segment) {
    return (segment && segment.transit) || {};
  }

  // 线路名只存在于 instruction，如「乘坐地铁1号线(湘湖--萧山国际机场)…」→ 地铁1号线
  function segmentLineName(segment) {
    var instruction = String((segment && segment.instruction) || '').trim();
    if (instruction) {
      var match = instruction.match(/乘坐(.+?)[\(（]/);
      if (match && match[1]) return match[1].trim();
      match = instruction.match(/乘坐([^，,。;；\s]+?号线)/);
      if (match && match[1]) return match[1].trim();
      match = instruction.match(/乘坐([^，,。;；\s]+?路)/);
      if (match && match[1]) return match[1].trim();
      // 抽不到就用整段说明当名字
      return instruction;
    }
    // 旧结构兼容：busline.name
    var legacy = readBuslines(segmentTransit(segment).buslines)[0];
    return (legacy && (legacy.name || legacy.type)) || '';
  }

  // 段的折线：真实结构在 transit.path；旧结构兼容 walking.steps / buslines[].path
  function segmentPathPoints(segment) {
    var transit = segmentTransit(segment);
    var path = normalizePath(transit.path);
    if (path.length > 1) return path;

    // 旧版步行段：segment.walking.steps[].path
    var walking = (segment && segment.walking) || transit.walking;
    if (walking && walking.steps) {
      var walkPoints = [];
      toArrayLike(walking.steps).forEach(function (step) {
        normalizePath(step && step.path).forEach(function (point) { walkPoints.push(point); });
      });
      if (walkPoints.length > 1) return walkPoints;
    }

    // 真实结构里步行段的 steps 也可能挂在 transit.steps 下
    if (transit.steps) {
      var stepPoints = [];
      toArrayLike(transit.steps).forEach(function (step) {
        normalizePath(step && step.path).forEach(function (point) { stepPoints.push(point); });
      });
      if (stepPoints.length > 1) return stepPoints;
    }

    // 旧结构兼容：buslines[0].path / polyline / 站点坐标
    var legacy = readBuslines(transit.buslines)[0];
    if (legacy) {
      var legacyPath = normalizePath(legacy.path);
      if (legacyPath.length < 2) legacyPath = normalizePath(legacy.polyline);
      if (legacyPath.length < 2) legacyPath = buslineStopPoints(legacy);
      if (legacyPath.length > 1) return legacyPath;
    }
    return [];
  }

  // 段的上/下车站：真实结构 transit.on_station / off_station；旧结构兼容 buslines
  function segmentStations(segment) {
    var transit = segmentTransit(segment);
    var on = normalizeStop(transit.on_station) || normalizeStop(transit.departure_stop);
    var off = normalizeStop(transit.off_station) || normalizeStop(transit.arrival_stop);
    var legacy = readBuslines(transit.buslines)[0];
    if (legacy) {
      if (!on) on = normalizeStop(legacy.departure_stop);
      if (!off) off = normalizeStop(legacy.arrival_stop);
    }
    return { on: on, off: off, legacy: legacy };
  }

  // 方案里的线路名（按出现顺序去重）
  function planLineNames(plan) {
    var names = [];
    planSegments(plan).forEach(function (segment) {
      if (segmentMode(segment) === 'WALK') return;
      var name = segmentLineName(segment);
      if (name && names.indexOf(name) < 0) names.push(name);
    });
    return names;
  }

  function collectPlanLineNames(plans) {
    var names = [];
    (plans || []).forEach(function (plan) {
      planLineNames(plan).forEach(function (name) {
        if (names.indexOf(name) < 0) names.push(name);
      });
    });
    return names;
  }

  // ---------------------------------------------- 途经站：LineSearch 补全线路站点

  function lineCacheKey(city, lineName) {
    return String(city || '') + '|' + lineName;
  }

  // 先试「地铁1号线」，再试「杭州地铁1号线」「1号线」
  function lineNameCandidates(cityName, lineName) {
    var candidates = [lineName];
    var cityBase = String(cityName || '').replace(/市$/, '');
    if (cityBase && lineName.indexOf(cityBase) !== 0) candidates.push(cityBase + lineName);
    var stripped = lineName.replace(/^(地铁|公交|快速公交|BRT)/, '');
    if (stripped && stripped !== lineName) candidates.push(stripped);
    return candidates.filter(function (name, index) {
      return name && candidates.indexOf(name) === index;
    });
  }

  // 线路名归一化：去掉括号注释、城市前缀和「地铁/公交」前缀，用于 POI buslines 比对
  function lineNameKey(name) {
    var text = String(name || '').replace(/[\(（].*$/, '').trim();
    text = text.replace(/^.*?(?:地铁|公交|快速公交|BRT)/, '');
    return text;
  }

  function poiHasLine(poi, lineName) {
    var target = lineNameKey(lineName);
    if (!target) return false;
    var rawList = poi && poi.buslines;
    var buslines = typeof rawList === 'string' ? [rawList] : toArrayLike(rawList);
    for (var i = 0; i < buslines.length; i += 1) {
      var raw = buslines[i];
      var name = typeof raw === 'string' ? raw : (raw && (raw.name || raw.line_name || ''));
      if (name && lineNameKey(name) === target) return true;
    }
    return false;
  }

  // 按站点在路线折线上的投影位置排序（沿线找店需要按顺序看站）
  function sortStationsByRoute(stations, routePoints) {
    if (!routePoints || routePoints.length < 2 || !stations.length) return stations;
    var cumulative = [0];
    for (var i = 1; i < routePoints.length; i += 1) {
      var dx = routePoints[i][0] - routePoints[i - 1][0];
      var dy = routePoints[i][1] - routePoints[i - 1][1];
      cumulative.push(cumulative[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    stations.forEach(function (station) {
      var best = Infinity;
      var bestPos = 0;
      for (var j = 1; j < routePoints.length; j += 1) {
        var a = routePoints[j - 1];
        var b = routePoints[j];
        var vx = b[0] - a[0];
        var vy = b[1] - a[1];
        var lengthSq = vx * vx + vy * vy;
        var t = lengthSq ? ((station.lng - a[0]) * vx + (station.lat - a[1]) * vy) / lengthSq : 0;
        t = Math.max(0, Math.min(1, t));
        var px = a[0] + t * vx;
        var py = a[1] + t * vy;
        var dist = (station.lng - px) * (station.lng - px) + (station.lat - py) * (station.lat - py);
        if (dist < best) {
          best = dist;
          bestPos = cumulative[j - 1] + t * Math.sqrt(lengthSq);
        }
      }
      station.routePos = bestPos;
      station.routeDistance = Math.sqrt(best);
    });
    return stations.sort(function (a, b) { return a.routePos - b.routePos; });
  }

  // 路线上下文：折线点（用于投影排序）+ 外接矩形（PlaceSearch 范围）
  function buildRouteContext(plans) {
    var ordered = [];
    if (plans && plans[0]) {
      planPaths(plans[0]).forEach(function (path) {
        path.forEach(function (point) { ordered.push(point); });
      });
    }
    var all = ordered.slice();
    (plans || []).forEach(function (plan) {
      planSegments(plan).forEach(function (segment) {
        if (segmentMode(segment) === 'WALK') return;
        var ends = segmentStations(segment);
        if (ends.on) all.push([ends.on.lng, ends.on.lat]);
        if (ends.off) all.push([ends.off.lng, ends.off.lat]);
      });
    });
    if (!all.length) return null;
    var minLng = Infinity;
    var minLat = Infinity;
    var maxLng = -Infinity;
    var maxLat = -Infinity;
    all.forEach(function (point) {
      if (point[0] < minLng) minLng = point[0];
      if (point[0] > maxLng) maxLng = point[0];
      if (point[1] < minLat) minLat = point[1];
      if (point[1] > maxLat) maxLat = point[1];
    });
    var pad = 0.02; // 约 2 公里，覆盖线路两侧的地铁站
    var bounds;
    try {
      bounds = new state.AMap.Bounds([minLng - pad, minLat - pad], [maxLng + pad, maxLat + pad]);
    } catch (err) {
      bounds = [[minLng - pad, minLat - pad], [maxLng + pad, maxLat + pad]];
    }
    return {
      routePoints: ordered.length > 1 ? ordered : all,
      bounds: bounds,
    };
  }

  function defaultRouteContext() {
    try {
      return {
        routePoints: [[120.2126, 30.2908], [120.24, 30.28], [120.28, 30.26], [120.32, 30.25]],
        bounds: new state.AMap.Bounds([120.15, 30.22], [120.38, 30.34]),
      };
    } catch (err) {
      return null;
    }
  }

  function resultKeys(result) {
    if (!result || typeof result !== 'object') return '';
    return Object.keys(result).join(',');
  }

  function firstItemKeys(items) {
    if (!items || !items.length) return '';
    var first = items[0];
    if (!first || typeof first !== 'object') return typeof first;
    return Object.keys(first).join(',');
  }

  function firstBuslineKeys(items) {
    if (!items || !items.length || !items[0] || !items[0].buslines) return '';
    var buslines = toArrayLike(items[0].buslines);
    if (!buslines.length) return '';
    var first = buslines[0];
    return first && typeof first === 'object' ? Object.keys(first).join(',') : typeof first;
  }

  function extractItems(source, result) {
    if (!result || typeof result !== 'object') return [];
    if (source === 'LineSearch') {
      var stations = [];
      toArrayLike(result.lineInfo).forEach(function (line) {
        toArrayLike(line && line.stations).forEach(function (stop) {
          if (!stop || typeof stop !== 'object') return;
          // 带上线路名，防止关键词「1号线」模糊命中「11号线」
          stations.push(Object.assign({}, stop, { __lineName: (line && line.name) || '' }));
        });
      });
      return stations;
    }
    if (source === 'StationSearch') {
      if (Array.isArray(result.stationInfo)) return result.stationInfo;
      if (Array.isArray(result.stationList)) return result.stationList;
      if (result.poiList && Array.isArray(result.poiList.pois)) return result.poiList.pois;
    }
    if (result.poiList && Array.isArray(result.poiList.pois)) return result.poiList.pois;
    // 兜底：取第一个数组属性
    var keys = Object.keys(result);
    for (var i = 0; i < keys.length; i += 1) {
      if (Array.isArray(result[keys[i]])) return result[keys[i]];
    }
    return [];
  }

  function countRawResults(source, result) {
    if (!result || typeof result !== 'object') return 0;
    if (source === 'LineSearch') return toArrayLike(result.lineInfo).length;
    if (source === 'StationSearch') {
      return toArrayLike(result.stationInfo || result.stationList ||
        (result.poiList && result.poiList.pois)).length;
    }
    return toArrayLike(result.poiList && result.poiList.pois).length;
  }

  // 统一的搜索包装：8 秒超时 + 记录 status/info/结果字段名，便于诊断
  function runSearch(source, keyword, runner) {
    return new Promise(function (resolve) {
      var settled = false;
      function finish(payload) {
        if (settled) return;
        settled = true;
        var result = payload.result;
        var items = extractItems(source, result);
        var firstKeys = '';
        if (source === 'LineSearch') {
          var firstLine = toArrayLike(result && result.lineInfo)[0];
          firstKeys = firstLine ? Object.keys(firstLine).join(',') : '';
        } else {
          firstKeys = firstItemKeys(items);
        }
        resolve({
          source: source,
          keyword: keyword,
          status: payload.status || 'error',
          info: payload.info !== undefined ? payload.info : ((result && result.info) || ''),
          resultKeys: resultKeys(result),
          firstKeys: firstKeys,
          buslineKeys: firstBuslineKeys(items),
          items: items,
          count: countRawResults(source, result),
          stationCount: items.length,
        });
      }
      setTimeout(function () {
        finish({ status: 'timeout', info: '8 秒未回调' });
      }, 8000);
      try {
        runner(finish);
      } catch (err) {
        finish({ status: 'error', info: messageOf(err) });
      }
    });
  }

  function runLineSearch(city, keyword) {
    return runSearch('LineSearch', keyword, function (finish) {
      var Ctor = state.AMap.LineSearch;
      if (!Ctor) {
        finish({ status: 'unsupported', info: 'AMap.LineSearch 不存在' });
        return;
      }
      var search;
      try {
        search = new Ctor({ city: city, pageSize: 50, extensions: 'all' });
      } catch (err) {
        finish({ status: 'error', info: messageOf(err) });
        return;
      }
      search.search(keyword, function (status, result) {
        finish({ status: status, result: result });
      });
    });
  }

  function runStationSearch(city, keyword) {
    return runSearch('StationSearch', keyword, function (finish) {
      var Ctor = state.AMap.StationSearch;
      if (!Ctor) {
        finish({ status: 'unsupported', info: 'AMap.StationSearch 不存在' });
        return;
      }
      var search;
      try {
        search = new Ctor({ city: city, pageSize: 50 });
      } catch (err) {
        finish({ status: 'error', info: messageOf(err) });
        return;
      }
      search.search(keyword, function (status, result) {
        finish({ status: status, result: result });
      });
    });
  }

  function runPlaceKeyword(city, keyword) {
    return runSearch('PlaceSearch 关键字', keyword, function (finish) {
      var Ctor = state.AMap.PlaceSearch;
      if (!Ctor) {
        finish({ status: 'unsupported', info: 'AMap.PlaceSearch 不存在' });
        return;
      }
      var search;
      try {
        search = new Ctor({ type: '150500', pageSize: 50, extensions: 'all', city: city, citylimit: true });
      } catch (err) {
        finish({ status: 'error', info: messageOf(err) });
        return;
      }
      search.search(keyword, function (status, result) {
        finish({ status: status, result: result });
      });
    });
  }

  function runPlaceBounds(city, keyword, context) {
    return runSearch('PlaceSearch 范围', keyword, function (finish) {
      var Ctor = state.AMap.PlaceSearch;
      if (!Ctor) {
        finish({ status: 'unsupported', info: 'AMap.PlaceSearch 不存在' });
        return;
      }
      if (!context || !context.bounds) {
        finish({ status: 'unsupported', info: '没有路线外接矩形' });
        return;
      }
      var search;
      try {
        search = new Ctor({ type: '150500', pageSize: 50, extensions: 'all' });
      } catch (err) {
        finish({ status: 'error', info: messageOf(err) });
        return;
      }
      if (typeof search.searchInBounds !== 'function') {
        finish({ status: 'unsupported', info: 'PlaceSearch 没有 searchInBounds 方法' });
        return;
      }
      search.searchInBounds(keyword, context.bounds, function (status, result) {
        finish({ status: status, result: result });
      });
    });
  }

  function matchedStationsFromItems(items, lineName) {
    var stations = [];
    toArrayLike(items).forEach(function (item) {
      if (!poiHasLine(item, lineName)) return;
      var stop = normalizeStop(item);
      if (stop) stations.push(stop);
    });
    return stations;
  }

  // 按 1→2→3→4 依次尝试四种来源；主流程命中即停，测试按钮 runAll=true 全跑一遍
  function collectViaStations(city, cityName, lineName, context, runAll) {
    if (state.debug) state.debug.viaCollectCalls = (state.debug.viaCollectCalls || 0) + 1;
    var keywords = lineNameCandidates(cityName, lineName);
    var sources = [
      {
        name: 'LineSearch',
        keywords: keywords,
        lineSpecific: true,
        run: function (keyword) { return runLineSearch(city, keyword); },
      },
      {
        name: 'StationSearch',
        keywords: keywords,
        lineSpecific: false,
        run: function (keyword) { return runStationSearch(city, keyword); },
      },
      {
        name: 'PlaceSearch 关键字',
        keywords: ['地铁站'],
        lineSpecific: false,
        run: function (keyword) { return runPlaceKeyword(city, keyword); },
      },
      {
        name: 'PlaceSearch 范围',
        keywords: ['', '地铁站'],
        lineSpecific: false,
        run: function (keyword) { return runPlaceBounds(city, keyword, context); },
      },
    ];
    var attempts = [];
    var adopted = null;
    var sourceIndex = 0;

    function nextSource() {
      if (sourceIndex >= sources.length) {
        return Promise.resolve({
          stations: adopted ? adopted.stations : [],
          attempts: attempts,
          source: adopted ? adopted.source : '',
          keyword: adopted ? adopted.keyword : '',
          status: adopted ? 'hit' : 'miss',
        });
      }
      var source = sources[sourceIndex];
      var keywordIndex = 0;

      function nextKeyword() {
        if (keywordIndex >= source.keywords.length) {
          sourceIndex += 1;
          return nextSource();
        }
        var keyword = source.keywords[keywordIndex];
        keywordIndex += 1;
        return source.run(keyword).then(function (res) {
          var matched;
          if (source.lineSpecific) {
            matched = [];
            res.items.forEach(function (item) {
              // LineSearch 返回的线路名要和目标线路一致，避免「1号线」命中「11号线」
              if (item.__lineName && lineNameKey(item.__lineName) !== lineNameKey(lineName)) return;
              var stop = normalizeStop(item);
              if (stop) matched.push(stop);
            });
          } else {
            matched = matchedStationsFromItems(res.items, lineName);
          }
          attempts.push({
            source: source.name,
            keyword: keyword,
            status: res.status,
            info: res.info || '',
            rawCount: res.count || 0,
            matchedCount: matched.length,
            resultKeys: res.resultKeys || '',
            firstKeys: res.firstKeys || '',
            buslineKeys: res.buslineKeys || '',
          });
          if (matched.length >= 2) {
            // LineSearch 返回的就是线路有序站序列，不能按路线投影重排；其他来源是无序 POI 才排序
            if (!source.lineSpecific) sortStationsByRoute(matched, context && context.routePoints);
            if (!adopted) {
              adopted = { source: source.name, keyword: keyword, stations: matched };
            }
            if (!runAll) {
              return {
                stations: matched,
                attempts: attempts,
                source: source.name,
                keyword: keyword,
                status: 'hit',
              };
            }
          }
          return nextKeyword();
        });
      }
      return nextKeyword();
    }
    return nextSource();
  }

  // 每条线路只查一次，结果按「城市 + 线路名」缓存在内存里
  function loadLineStations(city, cityName, lineName, context) {
    var cacheKey = lineCacheKey(city, lineName);
    if (state.lineCache[cacheKey]) return Promise.resolve(state.lineCache[cacheKey]);
    return collectViaStations(city, cityName, lineName, context, false).then(function (result) {
      var info = {
        lineName: lineName,
        stations: result.stations || [],
        status: result.status,
        source: result.source || '',
        keyword: result.keyword || '',
        attempts: result.attempts || [],
      };
      state.lineCache[cacheKey] = info;
      return info;
    });
  }

  function loadAllLineStations(city, cityName, lineNames, context) {
    var map = {};
    return (lineNames || []).reduce(function (chain, lineName) {
      return chain.then(function () {
        return loadLineStations(city, cityName, lineName, context).then(function (info) {
          map[lineName] = info;
        });
      });
    }, Promise.resolve()).then(function () { return map; });
  }

  // 在整条线有序站序列里定位一个站：先 id、再站名、最后坐标最近邻
  function locateStationIndex(sequence, target) {
    if (!sequence || !sequence.length || !target) return -1;
    var i;
    if (target.id) {
      for (i = 0; i < sequence.length; i += 1) {
        if (sequence[i].id && String(sequence[i].id) === String(target.id)) return i;
      }
    }
    if (target.name) {
      for (i = 0; i < sequence.length; i += 1) {
        if (sequence[i].name === target.name) return i;
      }
    }
    var best = -1;
    var bestDist = Infinity;
    for (i = 0; i < sequence.length; i += 1) {
      var dx = sequence[i].lng - target.lng;
      var dy = sequence[i].lat - target.lat;
      var dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    return best;
  }

  // 截取一段 transit 在整条线站序列中的区间（含上下车站）
  function segmentSliceStations(segment, lineInfo) {
    var ends = segmentStations(segment);
    var sequence = lineInfo && lineInfo.stations ? lineInfo.stations : [];
    if (!sequence.length || (!ends.on && !ends.off)) {
      return { stops: [], onIndex: -1, offIndex: -1, missing: true, ends: ends };
    }
    var onIndex = locateStationIndex(sequence, ends.on);
    var offIndex = locateStationIndex(sequence, ends.off);
    if (onIndex < 0 || offIndex < 0) {
      return { stops: [], onIndex: onIndex, offIndex: offIndex, missing: true, ends: ends };
    }
    var start = Math.min(onIndex, offIndex);
    var end = Math.max(onIndex, offIndex);
    var stops = sequence.slice(start, end + 1);
    // 反向乘车：按行驶方向反转，保证段首是上车站、段尾是下车站
    if (offIndex < onIndex) stops = stops.slice().reverse();
    return {
      stops: stops,
      onIndex: onIndex,
      offIndex: offIndex,
      missing: false,
      reversed: offIndex < onIndex,
      ends: ends,
    };
  }

  // 米制距离（等距圆柱近似，城市尺度够用）
  function distanceMeters(a, b) {
    var lat = (a[1] + b[1]) / 2 * Math.PI / 180;
    var dx = (b[0] - a[0]) * 111320 * Math.cos(lat);
    var dy = (b[1] - a[1]) * 110540;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function pathCumulative(path) {
    var cumulative = [0];
    for (var i = 1; i < path.length; i += 1) {
      cumulative.push(cumulative[i - 1] + distanceMeters(path[i - 1], path[i]));
    }
    return cumulative;
  }

  // 点投影到折线：返回里程 s（米）、垂直距离、投影点坐标
  function projectPointOnPath(point, path, cumulative) {
    var best = { s: 0, distance: Infinity, lng: point[0], lat: point[1], segmentIndex: -1, t: 0 };
    var lat0 = point[1] * Math.PI / 180;
    var mPerLng = 111320 * Math.cos(lat0);
    var mPerLat = 110540;
    for (var i = 1; i < path.length; i += 1) {
      var a = path[i - 1];
      var b = path[i];
      var ax = (a[0] - point[0]) * mPerLng;
      var ay = (a[1] - point[1]) * mPerLat;
      var bx = (b[0] - point[0]) * mPerLng;
      var by = (b[1] - point[1]) * mPerLat;
      var vx = bx - ax;
      var vy = by - ay;
      var lenSq = vx * vx + vy * vy;
      var t = lenSq ? -(ax * vx + ay * vy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      var px = ax + t * vx;
      var py = ay + t * vy;
      var dist = Math.sqrt(px * px + py * py);
      if (dist < best.distance) {
        best = {
          s: cumulative[i - 1] + t * Math.sqrt(lenSq),
          distance: dist,
          lng: point[0] + px / mPerLng,
          lat: point[1] + py / mPerLat,
          segmentIndex: i - 1,
          t: t,
        };
      }
    }
    return best;
  }

  function keptHasStation(kept, stop) {
    return kept.some(function (item) {
      return sameStation(item.stop, stop) ||
        (item.stop.name && stop.name && item.stop.name === stop.name);
    });
  }

  // 按折线里程截取一段 transit 的站：只保留 [s_on,s_off] 内且离折线 <=300m 的站
  function segmentArcSliceStations(segment, lineInfo) {
    var ends = segmentStations(segment);
    var sequence = lineInfo && lineInfo.stations ? lineInfo.stations : [];
    var path = normalizePath(segmentTransit(segment).path);
    if (path.length < 2) {
      // 折线点数不够：退回旧下标法，并在调试区标注「里程法不可用」
      var indexFallback = segmentSliceStations(segment, lineInfo);
      return Object.assign({}, indexFallback, {
        method: 'index',
        mileageUnavailable: true,
        candidateCount: sequence.length,
        keptCount: indexFallback.stops.length,
        dropped: [],
        droppedTotal: 0,
        sOn: null,
        sOff: null,
      });
    }
    if (!sequence.length || !ends.on || !ends.off) {
      var fallback = segmentSliceStations(segment, lineInfo);
      return Object.assign({}, fallback, {
        method: 'index',
        candidateCount: sequence.length,
        keptCount: fallback.stops.length,
        dropped: [],
        droppedTotal: 0,
        sOn: null,
        sOff: null,
      });
    }

    var cumulative = pathCumulative(path);
    var onProjection = projectPointOnPath([ends.on.lng, ends.on.lat], path, cumulative);
    var offProjection = projectPointOnPath([ends.off.lng, ends.off.lat], path, cumulative);
    if (!isFinite(onProjection.s) || !isFinite(offProjection.s)) {
      var fallback2 = segmentSliceStations(segment, lineInfo);
      return Object.assign({}, fallback2, {
        method: 'index',
        candidateCount: sequence.length,
        keptCount: fallback2.stops.length,
        dropped: [],
        droppedTotal: 0,
        sOn: null,
        sOff: null,
      });
    }

    var low = Math.min(onProjection.s, offProjection.s);
    var high = Math.max(onProjection.s, offProjection.s);
    var kept = [];
    var dropped = [];
    sequence.forEach(function (stop) {
      var projection = projectPointOnPath([stop.lng, stop.lat], path, cumulative);
      if (projection.distance > 300 || projection.s < low - 1 || projection.s > high + 1) {
        dropped.push(stop.name);
        return;
      }
      kept.push({ stop: stop, s: projection.s, distance: projection.distance });
    });

    // 上下车站必须出现在段首/段尾（线路站表里站名可能不同，用坐标投影兜底）
    if (!keptHasStation(kept, ends.on)) {
      kept.push({ stop: ends.on, s: onProjection.s, distance: onProjection.distance });
    }
    if (!keptHasStation(kept, ends.off)) {
      kept.push({ stop: ends.off, s: offProjection.s, distance: offProjection.distance });
    }
    kept.sort(function (a, b) {
      return onProjection.s <= offProjection.s ? a.s - b.s : b.s - a.s;
    });

    var stops = [];
    kept.forEach(function (item) {
      var last = stops[stops.length - 1];
      if (last && (sameStation(last, item.stop) || (last.name && last.name === item.stop.name))) return;
      stops.push(item.stop);
    });

    return {
      method: 'arc',
      sOn: onProjection.s,
      sOff: offProjection.s,
      candidateCount: sequence.length,
      keptCount: stops.length,
      dropped: dropped.slice(0, 10),
      droppedTotal: dropped.length,
      mileageUnavailable: false,
      missing: false,
      stops: stops,
      ends: ends,
    };
  }

  // 合并所有方案的地铁/公交站点，按站点 id 或坐标去重，并标注角色
  // lineStations: { 线路名: { stations: [{name,id,lng,lat}], ... } }，来自 LineSearch
  function buildStations(plans, lineStations) {
    if (state.debug) {
      state.debug.lastBuildPlanCount = (plans || []).length;
      state.debug.segmentSlices = [];
      state.debug.viaMissing = false;
    }
    var byKey = {};
    var list = [];

    function touch(stop, planIndex) {
      if (!stop) return null;
      var keys = stationKeys(stop);
      var station = null;
      keys.forEach(function (key) {
        if (!station && byKey[key]) station = byKey[key];
      });
      if (!station) {
        station = {
          key: keys[0],
          name: stop.name,
          id: stop.id,
          lng: stop.lng,
          lat: stop.lat,
          transfer: false,
          board: false,
          alight: false,
          via: false,
          planIndexes: [],
          lines: [],
        };
        list.push(station);
      }
      // 两种键都指向同一个站，后续带 id 或不带 id 的记录都能合并
      keys.forEach(function (key) { byKey[key] = station; });
      if (station.planIndexes.indexOf(planIndex) < 0) station.planIndexes.push(planIndex);
      return station;
    }

    function addLine(station, lineName) {
      if (lineName && station.lines.indexOf(lineName) < 0) station.lines.push(lineName);
    }

    plans.forEach(function (plan, planIndex) {
      try {
        var previousOff = null;
        planSegments(plan).forEach(function (segment) {
          var mode = segmentMode(segment);
          if (!mode || mode === 'WALK') return; // 步行段没有站点角色

          var lineName = segmentLineName(segment);
          var ends = segmentStations(segment);
          var lineInfo = lineName && lineStations ? lineStations[lineName] : null;
          // 优先按折线里程截取；折线不足时函数内部退回下标法
          var slice = segmentArcSliceStations(segment, lineInfo);

          if (slice.stops.length) {
            // 只画这一段内的站：段首上车站、段尾下车站、中间途经站
            slice.stops.forEach(function (stop, stopIndex) {
              var station = touch(stop, planIndex);
              if (!station) return;
              addLine(station, lineName);
              if (stopIndex === 0) station.board = true;
              if (stopIndex === slice.stops.length - 1) station.alight = true;
              if (stopIndex > 0 && stopIndex < slice.stops.length - 1) station.via = true;
            });
            // 换乘站：上一段下车站 == 本段第一个站
            if (previousOff && slice.stops[0] && sameStation(previousOff, slice.stops[0])) {
              var transferStation = touch(slice.stops[0], planIndex);
              if (transferStation) transferStation.transfer = true;
            }
            previousOff = slice.stops[slice.stops.length - 1];
          } else {
            // 站序列拿不到：退回只画上下车站（结果面板会明确提示）
            if (ends.on) {
              var boardStation = touch(ends.on, planIndex);
              if (boardStation) {
                boardStation.board = true;
                addLine(boardStation, lineName);
              }
            }
            if (ends.off) {
              var alightStation = touch(ends.off, planIndex);
              if (alightStation) {
                alightStation.alight = true;
                addLine(alightStation, lineName);
              }
            }
            if (previousOff && ends.on && sameStation(previousOff, ends.on)) {
              var transferStation2 = touch(ends.on, planIndex);
              if (transferStation2) transferStation2.transfer = true;
            }
            // 旧结构兼容：busline 自带的 via_stops
            var addedLegacyVia = false;
            if (ends.legacy) {
              toArrayLike(ends.legacy.via_stops).forEach(function (rawStop) {
                var stop = normalizeStop(rawStop);
                if (!stop) return;
                var viaStation = touch(stop, planIndex);
                if (viaStation) {
                  viaStation.via = true;
                  addLine(viaStation, lineName);
                  addedLegacyVia = true;
                }
              });
            }
            previousOff = ends.off;
            if (state.debug && !addedLegacyVia) state.debug.viaMissing = true;
          }

          if (state.debug && state.debug.segmentSlices) {
            state.debug.segmentSlices.push({
              lineName: lineName,
              method: slice.method || 'index',
              sOn: slice.sOn,
              sOff: slice.sOff,
              candidateCount: slice.candidateCount || 0,
              keptCount: slice.keptCount || 0,
              dropped: slice.dropped || [],
              droppedTotal: slice.droppedTotal || 0,
              mileageUnavailable: !!slice.mileageUnavailable,
              count: slice.stops.length,
              missing: slice.missing,
            });
          }
        });
      } catch (err) {
        if (state.debug && state.debug.drawErrors) {
          state.debug.drawErrors.push('方案 ' + (planIndex + 1) + ' 解析站点失败：' + messageOf(err));
        }
      }
    });

    return list;
  }

  function stationKind(station) {
    if (station.transfer) return 'transfer';
    if (station.board || station.alight) return 'stop';
    return 'via';
  }

  // ------------------------------------------------------------ 地图绘制

  function clearOverlays() {
    if (state.map && state.overlays.length) state.map.remove(state.overlays);
    state.overlays = [];
    if (state.infoWindow) {
      try {
        state.infoWindow.close();
      } catch (err) {
        // 没打开过时部分版本会报错，忽略即可
      }
    }
  }

  function resetDebug() {
    state.debug = {
      planCount: 0,
      polylineCount: 0,
      markerCount: 0,
      stationMarkerCount: 0,
      planPathCounts: [],
      selectedPlanIndex: -1,
      lastBuildPlanCount: 0,
      usedStopsFallback: false,
      usedStraightFallback: false,
      failureReason: '',
      manualFit: false,
      fitError: '',
      fitCalls: 0,
      fitLog: [],
      viaCollectCalls: 0,
      viaMissing: false,
      segmentSlices: [],
      poiRequests: 0,
      poiCacheHits: 0,
      poiErrors: [],
      poiKeyCount: 0,
      poiKeyTruncated: false,
      poiShopCount: 0,
      poiCoveredStations: 0,
      poiFullLineStations: 0,
      detailFields: null,
      drawErrors: [],
      lineSearch: [],
      lineSearchSupported: '',
      mapStatus: '',
      hitElement: '',
      interactionFixed: false,
      zoomBroken: false,
      zoom: '',
      center: '',
    };
    state.routePoints = [];
  }

  function clearResult() {
    clearOverlays();
    state.stations = [];
    state.plans = [];
    state.origin = null;
    state.dest = null;
    state.selectedPlanIndex = -1;
    state.planLoadToken += 1;
    state.lineStations = {};
    state.lineLoading = false;
    state.rawResult = null;
    state.rawJsonText = '';
    resetDebug();
    resetPoiState();
    hideResult();
  }

  // 高德返回的 path / polyline 可能是 LngLat 数组、[lng,lat] 数组、"lng,lat;lng,lat" 字符串，
  // 统一转成 [[lng, lat], ...]，保证 Polyline 一定拿到合法坐标
  function normalizePath(raw) {
    var points = [];
    if (!raw) return points;
    if (typeof raw === 'string') {
      raw.split(';').forEach(function (pair) {
        var ll = toLngLat(pair);
        if (ll) points.push([ll.getLng(), ll.getLat()]);
      });
      return points;
    }
    if (Array.isArray(raw)) {
      // 单个点：[lng, lat]
      if (raw.length >= 2 && typeof raw[0] === 'number' && typeof raw[1] === 'number') {
        var single = toLngLat(raw);
        if (single) points.push([single.getLng(), single.getLat()]);
        return points;
      }
      raw.forEach(function (item) {
        var ll = toLngLat(item);
        if (ll) points.push([ll.getLng(), ll.getLat()]);
      });
      return points;
    }
    var one = toLngLat(raw);
    if (one) points.push([one.getLng(), one.getLat()]);
    return points;
  }

  // 一条公交线路上按顺序的站点坐标：上车站 → 途经站 → 下车站
  function buslineStopPoints(busline) {
    var points = [];
    function add(stop) {
      var normalized = normalizeStop(stop);
      if (normalized) points.push([normalized.lng, normalized.lat]);
    }
    add(busline.departure_stop);
    toArrayLike(busline.via_stops).forEach(add);
    add(busline.arrival_stop);
    return points;
  }

  // 整个方案按顺序的站点坐标（跨换乘段串联），作为拿不到 path 时的兜底折线
  function planStopsPath(plan) {
    var points = [];
    function push(point) {
      var last = points[points.length - 1];
      if (!last || last[0] !== point[0] || last[1] !== point[1]) points.push(point);
    }
    planSegments(plan).forEach(function (segment) {
      var mode = segmentMode(segment);
      if (!mode || mode === 'WALK') return;
      var ends = segmentStations(segment);
      if (ends.on) push([ends.on.lng, ends.on.lat]);
      // 旧结构兼容：busline 的 via_stops
      if (ends.legacy) {
        toArrayLike(ends.legacy.via_stops).forEach(function (rawStop) {
          var stop = normalizeStop(rawStop);
          if (stop) push([stop.lng, stop.lat]);
        });
      }
      if (ends.off) push([ends.off.lng, ends.off.lat]);
    });
    return points;
  }

  // 一个方案要画的折线：2.0 真实结构直接用 segment.transit.path
  function planPaths(plan) {
    var paths = [];
    planSegments(plan).forEach(function (segment) {
      var path = segmentPathPoints(segment);
      if (path.length > 1) paths.push(path);
    });
    return paths;
  }

  function drawRoutes(plans, origin, dest) {
    var AMap = state.AMap;
    state.debug.planPathCounts = [];
    plans.forEach(function (plan, planIndex) {
      var color = ROUTE_COLORS[planIndex % ROUTE_COLORS.length];
      var isFirst = planIndex === 0;
      var paths = [];
      try {
        paths = planPaths(plan);
      } catch (err) {
        state.debug.drawErrors.push('方案 ' + (planIndex + 1) + ' 取折线失败：' + messageOf(err));
      }
      var items = paths.map(function (path) {
        return { points: path, dashed: false };
      });

      if (!items.length) {
        // 整条方案一段 path 都没有：用跨段串联的站点坐标兜底
        var stopsPath = planStopsPath(plan);
        if (stopsPath.length > 1) {
          items.push({ points: stopsPath, dashed: false });
          state.debug.usedStopsFallback = true;
        }
      }
      if (!items.length && isFirst && origin && dest) {
        // 最后兜底：起终点直线，必须画成虚线并标注「非真实路线」
        items.push({
          points: [[origin.lng, origin.lat], [dest.lng, dest.lat]],
          dashed: true,
        });
        state.debug.usedStraightFallback = true;
        state.debug.failureReason = '方案 ' + (planIndex + 1) +
          ' 没有任何 transit.path 或可用站点坐标，只能画起终点直线';
      }
      state.debug.planPathCounts.push(items.length);

      items.forEach(function (item) {
        try {
          var dashed = item.dashed;
          var polyline = new AMap.Polyline({
            path: item.points,
            strokeColor: dashed ? '#dc2626' : color,
            strokeWeight: dashed ? 4 : (isFirst ? 7 : 4),
            strokeOpacity: dashed ? 0.9 : (isFirst ? 0.95 : 0.55),
            strokeStyle: dashed ? 'dashed' : 'solid',
            strokeDasharray: dashed ? [10, 8] : undefined,
            isOutline: !dashed && isFirst,
            outlineColor: '#ffffff',
            borderWeight: 2,
            lineJoin: 'round',
            lineCap: 'round',
            zIndex: dashed ? 80 : (isFirst ? 70 : 60),
          });
          state.map.add(polyline);
          state.overlays.push(polyline);
          state.debug.polylineCount += 1;
          item.points.forEach(function (point) { state.routePoints.push(point); });
        } catch (err) {
          state.debug.drawErrors.push('方案 ' + (planIndex + 1) + ' 画线失败：' + messageOf(err));
        }
      });
    });
  }

  function endpointMarker(place, kind, text) {
    var AMap = state.AMap;
    var marker = new AMap.Marker({
      position: [place.lng, place.lat],
      content: '<div class="mk mk-endpoint mk-' + kind + '"><span class="mk-dot">' + text + '</span></div>',
      anchor: 'center',
      // 起终点和站点经常几乎重合：端点标记上移，站点圆点保持在坐标上，两者都能看到
      offset: new AMap.Pixel(0, -30),
      zIndex: 180,
      title: place.name,
    });
    marker.on('click', function () {
      openInfo(
        '<div class="iw"><strong>' + escapeHtml(place.name) + '</strong>' +
        '<p>' + (kind === 'origin' ? '起点' : '终点') + '</p></div>',
        [place.lng, place.lat]
      );
    });
    state.map.add(marker);
    state.overlays.push(marker);
    state.debug.markerCount += 1;
    state.routePoints.push([place.lng, place.lat]);
  }

  function drawStationMarkers(stations) {
    var AMap = state.AMap;
    stations.forEach(function (station) {
      var kind = stationKind(station);
      var marker = new AMap.Marker({
        position: [station.lng, station.lat],
        content: '<div class="mk mk-' + kind + '"><span class="mk-dot"></span></div>',
        anchor: 'center',
        // 站点圆点必须压在起终点标记之上，否则重合时看不到站点
        zIndex: kind === 'transfer' ? 230 : kind === 'stop' ? 220 : 210,
        title: station.name,
      });
      marker.on('click', function () {
        focusStation(station);
      });
      state.map.add(marker);
      state.overlays.push(marker);
      state.debug.markerCount += 1;
      state.debug.stationMarkerCount += 1;
      state.routePoints.push([station.lng, station.lat]);
    });
  }

  function openInfo(html, position) {
    if (!state.infoWindow) {
      state.infoWindow = new state.AMap.InfoWindow({
        offset: new state.AMap.Pixel(0, -20),
        // 关键：关掉 InfoWindow 自动挪地图，避免和 setZoomAndCenter 抢方向
        autoMove: false,
      });
    }
    state.infoWindow.setContent(html);
    state.infoWindow.open(state.map, position);
  }

  // 点站点显示站名与线路
  function openStationInfo(station) {
    var roles = [];
    if (station.transfer) roles.push('换乘站');
    if (station.board) roles.push('上车站');
    if (station.alight) roles.push('下车站');
    if (!roles.length) roles.push('途经站');

    openInfo(
      '<div class="iw"><strong>' + escapeHtml(station.name) + '</strong>' +
      '<p>' + roles.join(' · ') + '</p>' +
      (station.lines.length ? '<p>线路：' + escapeHtml(station.lines.join(' / ')) + '</p>' : '') +
      '<p>出现在 ' + station.planIndexes.length + ' 个方案中</p></div>',
      [station.lng, station.lat]
    );
  }

  // ------------------------------------------------------------ 站点周边 POI

  function poiStationKey(station) {
    if (!station) return '';
    return station.key || stationKeys(station)[0];
  }

  function poiCategoryClass(category) {
    return POI_CATEGORY_CLASS[category] || 'other';
  }

  function poiTypeCodes(categories) {
    var codes = [];
    (categories || []).forEach(function (category) {
      var code = POI_TYPE_CODES[category];
      if (code && codes.indexOf(code) < 0) codes.push(code);
    });
    return codes.join('|');
  }

  function classifyPoi(poi, categories) {
    var text = String((poi.type || '') + ' ' + (poi.name || '') + ' ' + (poi.typecode || ''));
    var rules = [
      ['旅馆', /旅馆|招待所|青年旅舍|民宿/],
      ['酒店', /酒店|宾馆|饭店|住宿/],
      ['超市', /超市|便利店|购物中心|商场|生鲜/],
      ['按摩', /按摩|足疗|推拿|养生|spa/i],
      ['美食', /餐饮|美食|餐厅|小吃|快餐|火锅|咖啡|茶|烧烤/],
    ];
    for (var i = 0; i < rules.length; i += 1) {
      if (categories.indexOf(rules[i][0]) >= 0 && rules[i][1].test(text)) return rules[i][0];
    }
    return categories[0] || '其他';
  }

  function poiCacheKey(city, station, categories, radius) {
    var stationKey = station.id || (station.lng.toFixed(6) + ',' + station.lat.toFixed(6));
    return [city || '', stationKey, categories.slice().sort().join('+'), radius].join('|');
  }

  function poiBizExt(poi) {
    var biz = poi && poi.biz_ext;
    if (typeof biz === 'string') {
      try {
        biz = JSON.parse(biz);
      } catch (err) {
        biz = null;
      }
    }
    return biz && typeof biz === 'object' ? biz : {};
  }

  function normalizePoiText(value) {
    if (value === undefined || value === null) return '';
    if (Array.isArray(value)) return value.filter(Boolean).join(' / ');
    if (typeof value === 'object') {
      return Object.keys(value).map(function (key) { return value[key]; })
        .filter(Boolean).join(' / ');
    }
    return String(value).trim();
  }

  function normalizePoiPhotos(poi) {
    var raw = poi && (poi.photos || poi.photo);
    if (!raw) return [];
    var items = Array.isArray(raw) ? raw : (typeof raw === 'string' ? [raw] : toArrayLike(raw));
    var urls = [];
    items.forEach(function (item) {
      var url = typeof item === 'string' ? item : (item && (item.url || item.src));
      if (!url) return;
      url = String(url).trim();
      if (url.indexOf('//') === 0) url = 'https:' + url;
      if (!/^https?:\/\//i.test(url)) return;
      if (urls.indexOf(url) < 0) urls.push(url);
    });
    return urls;
  }

  function normalizePoiTel(poi) {
    var raw = poi && (poi.tel || poi.phone);
    if (Array.isArray(raw)) return raw.filter(Boolean).join(' / ');
    return raw ? String(raw) : '';
  }

  function normalizePoiOpenTime(poi) {
    var biz = poiBizExt(poi);
    var raw = biz.open_time || biz.opentime2 || biz.opentime || biz.business_time ||
      (poi && (poi.open_time || poi.business_time));
    return normalizePoiText(raw);
  }

  function buildCtripUrl(city, name) {
    return 'https://m.ctrip.com/webapp/hotel/hotellist?cityName=' +
      encodeURIComponent(city || '') + '&keyword=' + encodeURIComponent(name || '');
  }

  function extractPois(result, station, categories) {
    var pois = result && result.poiList && result.poiList.pois;
    var list = [];
    toArrayLike(pois).forEach(function (poi) {
      var ll = toLngLat(poi && poi.location);
      if (!ll) return;
      var lng = ll.getLng();
      var lat = ll.getLat();
      var biz = poiBizExt(poi);
      list.push({
        id: poi.id || (poi.name + '@' + lng.toFixed(6) + ',' + lat.toFixed(6)),
        name: poi.name || '未命名地点',
        type: poi.type || '',
        typecode: poi.typecode || '',
        category: classifyPoi(poi, categories),
        lng: lng,
        lat: lat,
        distance: distanceMeters([station.lng, station.lat], [lng, lat]),
        address: poi.address || '',
        tel: normalizePoiTel(poi),
        photos: normalizePoiPhotos(poi),
        rating: normalizePoiText(biz.rating || poi.rating),
        cost: normalizePoiText(biz.cost || biz.price || poi.cost),
        openTime: normalizePoiOpenTime(poi),
        cityName: poi.cityname || poi.city || '',
        rawKeys: Object.keys(poi),
        bizKeys: Object.keys(biz),
      });
    });
    return list;
  }

  // 每站一次周边搜索；关键词用「|」合并品类，失败再退回 types 参数
  function searchPoisNearStation(station, categories, radius, city) {
    return new Promise(function (resolve) {
      var AMap = state.AMap;
      var PlaceSearchCtor = AMap.PlaceSearch;
      if (!PlaceSearchCtor) {
        resolve({ status: 'unsupported', info: 'AMap.PlaceSearch 不存在', pois: [] });
        return;
      }
      var search;
      try {
        search = new PlaceSearchCtor({ city: city || '', pageSize: 50, extensions: 'all' });
      } catch (err) {
        resolve({ status: 'error', info: messageOf(err), pois: [] });
        return;
      }
      var center = new AMap.LngLat(station.lng, station.lat);
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        resolve(value);
      }
      setTimeout(function () {
        finish({ status: 'timeout', info: '周边搜索超时', pois: [] });
      }, 10000);

      function request(keyword, useTypes) {
        if (settled) return;
        if (useTypes) {
          if (typeof search.setType !== 'function') {
            finish({ status: 'unsupported', info: 'PlaceSearch 没有 setType 方法', pois: [] });
            return;
          }
          try {
            search.setType(poiTypeCodes(categories));
          } catch (err) {
            finish({ status: 'error', info: messageOf(err), pois: [] });
            return;
          }
        }
        state.debug.poiRequests = (state.debug.poiRequests || 0) + 1;
        search.searchNearBy(keyword, center, radius, function (status, result) {
          var pois = extractPois(result, station, categories);
          var info = (result && result.info) || '';
          if (pois.length) {
            finish({ status: status, info: info, pois: pois });
            return;
          }
          if (!useTypes) {
            request('', true);
            return;
          }
          finish({ status: status, info: info, pois: [] });
        });
      }

      try {
        request(categories.join('|'), false);
      } catch (err) {
        finish({ status: 'error', info: messageOf(err), pois: [] });
      }
    });
  }

  function mergePoiShops(pois, station) {
    (pois || []).forEach(function (poi) {
      var candidate = {
        id: poi.id,
        name: poi.name,
        category: poi.category,
        lng: poi.lng,
        lat: poi.lat,
        distance: poi.distance,
        address: poi.address || '',
        tel: poi.tel || '',
        photos: poi.photos || [],
        rating: poi.rating || '',
        cost: poi.cost || '',
        openTime: poi.openTime || '',
        cityName: poi.cityName || '',
        rawKeys: poi.rawKeys || [],
        bizKeys: poi.bizKeys || [],
        stationName: station.name,
        stationKey: poiStationKey(station),
      };
      var existing = state.poiShops[candidate.id];
      if (!existing || candidate.distance < existing.distance) {
        state.poiShops[candidate.id] = candidate;
      }
    });
  }

  function ensurePoiForStation(station, categories, radius, city) {
    var cacheKey = poiCacheKey(city, station, categories, radius);
    var stationKey = poiStationKey(station);
    if (state.poiCache[cacheKey]) {
      state.debug.poiCacheHits = (state.debug.poiCacheHits || 0) + 1;
      state.poiQueried[stationKey] = true;
      mergePoiShops(state.poiCache[cacheKey].pois, station);
      return Promise.resolve(state.poiCache[cacheKey]);
    }
    return searchPoisNearStation(station, categories, radius, city).then(function (result) {
      state.poiCache[cacheKey] = result;
      state.poiQueried[stationKey] = true;
      if (result.pois.length) {
        mergePoiShops(result.pois, station);
      } else {
        state.debug.poiErrors.push(station.name + '：' + (result.status || 'no_data') +
          (result.info ? '（' + result.info + '）' : ''));
      }
      return result;
    });
  }

  function buildPoiStationUniverse() {
    var byKey = {};
    var list = [];

    function touch(stop, lineName, role) {
      var normalized = normalizeStop(stop);
      if (!normalized) return null;
      var key = stationKeys(normalized)[0];
      var station = byKey[key];
      if (!station) {
        station = {
          key: key,
          name: normalized.name,
          id: normalized.id,
          lng: normalized.lng,
          lat: normalized.lat,
          transfer: false,
          board: false,
          alight: false,
          via: false,
          lines: [],
          planIndexes: [0],
        };
        byKey[key] = station;
        list.push(station);
      }
      if (lineName && station.lines.indexOf(lineName) < 0) station.lines.push(lineName);
      if (role === 'board') station.board = true;
      if (role === 'alight') station.alight = true;
      if (role === 'via') station.via = true;
      if (role === 'transfer') station.transfer = true;
      return station;
    }

    var plan = state.plans[state.selectedPlanIndex];
    if (plan) {
      planLineNames(plan).forEach(function (lineName) {
        var info = state.lineStations[lineName];
        toArrayLike(info && info.stations).forEach(function (stop) {
          touch(stop, lineName, 'via');
        });
      });
    }
    // 经过段的上下车/换乘角色合并到整条线站点上
    state.stations.forEach(function (segmentStation) {
      var station = touch(segmentStation, (segmentStation.lines || [])[0], '');
      if (!station) return;
      station.board = station.board || segmentStation.board;
      station.alight = station.alight || segmentStation.alight;
      station.transfer = station.transfer || segmentStation.transfer;
      (segmentStation.lines || []).forEach(function (lineName) {
        if (station.lines.indexOf(lineName) < 0) station.lines.push(lineName);
      });
    });
    return list;
  }

  // 关键站：B 站 + B 前 5 站 + 上下车站/换乘站，去重后最多 8 个（D10 配额控制）
  function selectKeyStations() {
    var route = state.stations.slice();
    if (!route.length) return [];
    var bIndex = route.length - 1;
    if (state.dest) {
      var best = -1;
      var bestDistance = Infinity;
      route.forEach(function (station, index) {
        var distance = distanceMeters([station.lng, station.lat], [state.dest.lng, state.dest.lat]);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      });
      if (best >= 0) bIndex = best;
    }
    var keys = [];
    var seen = {};
    function add(station) {
      if (!station) return;
      var key = poiStationKey(station);
      if (!key || seen[key]) return;
      seen[key] = true;
      keys.push(station);
    }
    add(route[bIndex]);
    for (var i = 1; i <= 5; i += 1) {
      if (bIndex - i >= 0) add(route[bIndex - i]);
    }
    // 角色优先级：上车站、下车站优先于换乘站，避免 8 个名额被换乘站占满
    route.forEach(function (station) { if (station.board) add(station); });
    route.forEach(function (station) { if (station.alight) add(station); });
    route.forEach(function (station) { if (station.transfer) add(station); });
    state.debug.poiKeyTruncated = keys.length > 8;
    state.debug.poiKeyCount = Math.min(keys.length, 8);
    return keys.slice(0, 8);
  }

  function removeOverlayList(list) {
    if (!list || !list.length) return;
    if (state.map) state.map.remove(list);
    state.overlays = state.overlays.filter(function (overlay) {
      return list.indexOf(overlay) < 0;
    });
    list.length = 0;
  }

  // 进入查周边阶段：叠加整条线（更淡）+ 全部站点，不清理经过段
  function drawFullLineStage() {
    removeOverlayList(state.poiLineOverlays);
    state.poiLineOverlays = [];
    var plan = state.plans[state.selectedPlanIndex];
    if (!plan) return;
    var addedStations = 0;
    planLineNames(plan).forEach(function (lineName, lineIndex) {
      var info = state.lineStations[lineName];
      var stations = toArrayLike(info && info.stations).map(normalizeStop).filter(Boolean);
      if (stations.length > 1) {
        var path = stations.map(function (station) { return [station.lng, station.lat]; });
        try {
          var polyline = new state.AMap.Polyline({
            path: path,
            strokeColor: ROUTE_COLORS[lineIndex % ROUTE_COLORS.length],
            strokeWeight: 4,
            strokeOpacity: 0.45,
            lineJoin: 'round',
            lineCap: 'round',
            zIndex: 55,
          });
          state.map.add(polyline);
          state.overlays.push(polyline);
          state.poiLineOverlays.push(polyline);
          path.forEach(function (point) { state.routePoints.push(point); });
        } catch (err) {
          state.debug.drawErrors.push('画整条线失败：' + messageOf(err));
        }
      }
      stations.forEach(function (stop) {
        var inSegment = state.stations.some(function (segmentStation) {
          return sameStation(segmentStation, stop);
        });
        if (inSegment) return;
        try {
          var marker = new state.AMap.Marker({
            position: [stop.lng, stop.lat],
            content: '<div class="mk mk-line"><span class="mk-dot"></span></div>',
            anchor: 'center',
            zIndex: 200,
            title: stop.name,
          });
          marker.on('click', function () {
            focusStation({
              name: stop.name,
              lng: stop.lng,
              lat: stop.lat,
              lines: [lineName],
              planIndexes: [0],
              transfer: false,
              board: false,
              alight: false,
              via: true,
            });
          });
          state.map.add(marker);
          state.overlays.push(marker);
          state.poiLineOverlays.push(marker);
          addedStations += 1;
        } catch (err) {
          state.debug.drawErrors.push('画整条线站点失败：' + messageOf(err));
        }
      });
    });
    state.debug.poiFullLineStations = addedStations;
  }

  function ensurePoiStage() {
    if (state.poiActive) return;
    state.poiActive = true;
    drawFullLineStage();
    state.poiStations = buildPoiStationUniverse();
    renderStationList();
    renderPoiPanel();
  }

  function formatPoiCost(value) {
    var text = String(value || '').trim();
    if (!text) return '';
    if (/[¥￥元]/.test(text)) return text;
    return '¥' + text;
  }

  function appendShopRow(label, value, href) {
    if (!els.shopCardRows || !value) return;
    var row = document.createElement('div');
    row.className = 'shop-row';
    var labelEl = document.createElement('span');
    labelEl.className = 'shop-row-label';
    labelEl.textContent = label;
    var valueEl = document.createElement('span');
    valueEl.className = 'shop-row-value';
    if (href) {
      var link = document.createElement('a');
      link.href = href;
      link.textContent = value;
      valueEl.appendChild(link);
    } else {
      valueEl.textContent = value;
    }
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    els.shopCardRows.appendChild(row);
  }

  function renderShopPhotos(shop) {
    if (!els.shopCardPhotos) return;
    els.shopCardPhotos.innerHTML = '';
    var photos = shop.photos || [];
    els.shopCardPhotos.hidden = photos.length === 0;
    photos.forEach(function (url) {
      var img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = shop.name || '店铺照片';
      img.src = url;
      img.addEventListener('error', function () {
        if (img.parentNode) img.parentNode.removeChild(img);
        if (!els.shopCardPhotos.children.length) els.shopCardPhotos.hidden = true;
      });
      els.shopCardPhotos.appendChild(img);
    });
  }

  function renderShopRows(shop) {
    if (!els.shopCardRows) return;
    els.shopCardRows.innerHTML = '';
    if (shop.category) appendShopRow('品类', shop.category);
    if (shop.rating) appendShopRow('评分', shop.rating);
    if (shop.cost) appendShopRow('人均', formatPoiCost(shop.cost));
    if (shop.openTime) appendShopRow('营业时间', shop.openTime);
    if (shop.tel) {
      var digits = String(shop.tel).replace(/[^\d+]/g, '');
      appendShopRow('电话', shop.tel, digits.length >= 3 ? 'tel:' + digits : null);
    }
    if (shop.address) appendShopRow('地址', shop.address);
    if (shop.stationName) {
      appendShopRow('最近站', shop.stationName + ' · ' + formatDistance(shop.distance));
    }
    if (shop.toBMinutes) {
      appendShopRow('到 B 总时间', '约 ' + Math.round(shop.toBMinutes) + ' 分钟');
    }
  }

  function updateShopCardActions(shop) {
    var city = shop.cityName ||
      (state.lastQuery && (state.lastQuery.cityName || state.lastQuery.city)) || '';
    state.shopCardCopyText = (city ? city + ' ' : '') + (shop.name || '');
    if (els.shopCardCtrip) {
      els.shopCardCtrip.href = buildCtripUrl(city, shop.name);
      els.shopCardCtrip.target = '_blank';
      els.shopCardCtrip.setAttribute('rel', 'noopener noreferrer');
    }
  }

  function openShopCard(shop) {
    if (!shop || !els.shopCard) return;
    state.shopCardShop = shop;
    els.shopCard.hidden = false;
    if (els.shopCardSheet) els.shopCardSheet.scrollTop = 0;
    if (els.shopCardName) els.shopCardName.textContent = shop.name || '';
    if (els.shopCardSub) {
      var parts = [shop.category];
      if (shop.stationName) parts.push('最近站 ' + shop.stationName);
      els.shopCardSub.textContent = parts.filter(Boolean).join(' · ');
    }
    renderShopPhotos(shop);
    renderShopRows(shop);
    updateShopCardActions(shop);
    state.debug.detailFields = {
      photos: (shop.photos || []).length,
      tel: !!shop.tel,
      rating: shop.rating || '',
      cost: shop.cost || '',
      openTime: !!shop.openTime,
      rawKeys: (shop.rawKeys || []).join(','),
      bizKeys: (shop.bizKeys || []).join(','),
    };
    updateDebug();
  }

  function closeShopCard() {
    if (els.shopCard) els.shopCard.hidden = true;
    state.shopCardShop = null;
  }

  function copyTextWithFallback(text, button, defaultLabel) {
    var reset = function (label) {
      if (!button) return;
      button.textContent = label;
      setTimeout(function () { button.textContent = defaultLabel; }, 1600);
    };
    var fallback = function () {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (err) {
        ok = false;
      }
      document.body.removeChild(area);
      reset(ok ? '已复制' : '复制失败，请长按店名');
    };
    if (!text) {
      reset('没有可复制内容');
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        reset('已复制');
      }, fallback);
    } else {
      fallback();
    }
  }

  function renderPoiMarkers() {
    removeOverlayList(state.poiOverlays);
    state.poiOverlays = [];
    Object.keys(state.poiShops).forEach(function (id) {
      var shop = state.poiShops[id];
      var categoryClass = poiCategoryClass(shop.category);
      try {
        var marker = new state.AMap.Marker({
          position: [shop.lng, shop.lat],
          content: '<div class="shop-mk shop-' + categoryClass + '"><span class="shop-dot"></span></div>',
          anchor: 'center',
          zIndex: 240,
          title: shop.name,
        });
        marker.on('click', function () {
          openShopCard(shop);
        });
        state.map.add(marker);
        state.overlays.push(marker);
        state.poiOverlays.push(marker);
      } catch (err) {
        state.debug.drawErrors.push('画店铺 marker 失败：' + messageOf(err));
      }
    });
  }

  function renderPoiList() {
    var shops = Object.keys(state.poiShops).map(function (id) { return state.poiShops[id]; });
    shops.sort(function (a, b) { return a.distance - b.distance; });
    var covered = {};
    shops.forEach(function (shop) { covered[shop.stationKey] = true; });
    state.debug.poiShopCount = shops.length;
    state.debug.poiCoveredStations = Object.keys(covered).length;
    if (els.poiStats) {
      els.poiStats.textContent = '共 ' + shops.length + ' 家店，覆盖 ' +
        Object.keys(covered).length + ' 个站';
    }
    if (!els.poiList) return;
    if (!shops.length) {
      els.poiList.innerHTML = '<li class="empty">' +
        (state.poiLoading ? '正在查询…' : '还没有查询结果') + '</li>';
      return;
    }
    els.poiList.innerHTML = shops.map(function (shop) {
      return '<li><button type="button" class="poi-item" data-shop-id="' + escapeHtml(shop.id) + '">' +
        '<span class="poi-name">' + escapeHtml(shop.name) + '</span>' +
        '<span class="poi-cat">' + escapeHtml(shop.category) + '</span>' +
        '<span class="poi-meta">最近站 ' + escapeHtml(shop.stationName) +
        ' · ' + formatDistance(shop.distance) + '</span>' +
        '</button></li>';
    }).join('');
  }

  function renderPoiPanel() {
    if (!els.poiPanel) return;
    var show = state.selectedPlanIndex >= 0;
    if (els.poiOpenBtn) {
      els.poiOpenBtn.hidden = !show;
      els.poiOpenBtn.textContent = state.poiDrawerOpen ? '收起查周边' : '查周边';
    }
    els.poiPanel.hidden = !(show && state.poiDrawerOpen);
    if (!show) return;
    if (els.poiQueryBtn) {
      els.poiQueryBtn.disabled = state.poiLoading || state.lineLoading;
      els.poiQueryBtn.textContent = state.poiLoading ? '查询中…' : '查询周边';
    }
    renderPoiList();
  }

  function showPoiNotice(text) {
    if (!els.poiNotice) return;
    els.poiNotice.hidden = false;
    els.poiNotice.textContent = text;
  }

  function clearPoiNotice() {
    if (!els.poiNotice) return;
    els.poiNotice.hidden = true;
    els.poiNotice.textContent = '';
  }

  // 品类/半径变了：保留整条线叠加，清掉旧店铺结果与已查标记，等用户重新查询
  function resetPoiResults() {
    closeShopCard();
    removeOverlayList(state.poiOverlays);
    state.poiOverlays = [];
    state.poiQueried = {};
    state.poiShops = {};
    state.poiKeyStations = [];
    state.poiLoading = false;
    state.poiQueryToken += 1;
    if (state.debug) {
      state.debug.poiShopCount = 0;
      state.debug.poiCoveredStations = 0;
      state.debug.poiKeyCount = 0;
      state.debug.poiKeyTruncated = false;
      state.debug.poiRequests = 0;
      state.debug.poiCacheHits = 0;
      state.debug.poiErrors = [];
    }
    renderPoiList();
    renderPoiPanel();
    renderStationList();
  }

  function resetPoiState() {
    removeOverlayList(state.poiOverlays);
    state.poiOverlays = [];
    removeOverlayList(state.poiLineOverlays);
    state.poiLineOverlays = [];
    state.poiActive = false;
    state.poiDrawerOpen = false;
    state.poiLoading = false;
    closeShopCard();
    state.shopCardCopyText = '';
    state.poiStations = [];
    state.poiQueried = {};
    state.poiShops = {};
    state.poiKeyStations = [];
    state.poiQueryToken += 1;
    if (state.debug) {
      state.debug.poiRequests = 0;
      state.debug.poiCacheHits = 0;
      state.debug.poiErrors = [];
      state.debug.poiKeyCount = 0;
      state.debug.poiKeyTruncated = false;
      state.debug.poiShopCount = 0;
      state.debug.poiCoveredStations = 0;
      state.debug.poiFullLineStations = 0;
    }
    renderPoiPanel();
  }

  function runPoiQueryForStations(stations) {
    if (state.poiLoading) return;
    if (state.selectedPlanIndex < 0) return;
    var categories = state.poiCategories.slice();
    if (!categories.length) {
      showPoiNotice('请至少勾选一个品类。');
      return;
    }
    if (!stations || !stations.length) {
      showPoiNotice('没有可查询的站点。');
      return;
    }
    if (state.lineLoading) {
      showPoiNotice('线路站点还在加载，稍后再试。');
      return;
    }
    state.poiDrawerOpen = true;
    ensurePoiStage();
    clearPoiNotice();
    state.poiLoading = true;
    state.poiQueryToken += 1;
    var token = state.poiQueryToken;
    var radius = state.poiRadius;
    var city = (state.lastQuery && state.lastQuery.city) || '';
    renderPoiPanel();
    setStatus('正在查询 ' + stations.length + ' 个站点的周边…');

    var chain = Promise.resolve();
    stations.forEach(function (station) {
      chain = chain.then(function () {
        if (token !== state.poiQueryToken) return null;
        return ensurePoiForStation(station, categories, radius, city);
      });
    });
    chain.then(function () {
      if (token !== state.poiQueryToken) return;
      state.poiLoading = false;
      renderPoiMarkers();
      renderPoiList();
      renderPoiPanel();
      renderStationList();
      fitOverlays('poi-shops');
      setStatus('周边查询完成：共 ' + state.debug.poiShopCount + ' 家店。');
    }).catch(function (err) {
      if (token !== state.poiQueryToken) return;
      state.poiLoading = false;
      state.debug.poiErrors.push(messageOf(err));
      renderPoiPanel();
      setStatus('');
      showPoiNotice('周边查询失败：' + messageOf(err));
    });
  }

  function runPoiForKeys() {
    var keyStations = selectKeyStations();
    state.poiKeyStations = keyStations;
    if (!keyStations.length) {
      showPoiNotice('没有可查询的站点。');
      return;
    }
    runPoiQueryForStations(keyStations);
  }

  function loadPoiForStationByKey(key) {
    var station = state.poiStations.filter(function (item) {
      return poiStationKey(item) === key;
    })[0];
    if (!station) return;
    runPoiQueryForStations([station]);
  }


  // 本次路线坐标范围（setFitView 失效时手动兜底用）
  function routeBounds() {
    if (!state.routePoints.length) return null;
    var minLng = Infinity;
    var minLat = Infinity;
    var maxLng = -Infinity;
    var maxLat = -Infinity;
    state.routePoints.forEach(function (point) {
      if (point[0] < minLng) minLng = point[0];
      if (point[0] > maxLng) maxLng = point[0];
      if (point[1] < minLat) minLat = point[1];
      if (point[1] > maxLat) maxLat = point[1];
    });
    if (!isFinite(minLng) || !isFinite(minLat)) return null;
    return { southWest: [minLng, minLat], northEast: [maxLng, maxLat] };
  }

  function safeZoom(map) {
    if (!map) return null;
    try {
      var zoom = map.getZoom();
      return (typeof zoom === 'number' && isFinite(zoom)) ? zoom : null;
    } catch (err) {
      return null;
    }
  }

  // 查询后如果发现地图交互被禁用，自动恢复（并写进调试区）
  function ensureMapInteractive() {
    if (!state.map) return;
    var status = null;
    try {
      status = state.map.getStatus();
    } catch (err) {
      state.debug.drawErrors.push('getStatus 失败：' + messageOf(err));
      return;
    }
    if (!status) return;
    var keys = ['dragEnable', 'zoomEnable', 'rotateEnable', 'doubleClickZoom', 'scrollWheel', 'touchZoom', 'keyboardEnable'];
    var fix = {};
    keys.forEach(function (key) {
      if (status[key] === false) fix[key] = true;
    });
    if (Object.keys(fix).length) {
      try {
        state.map.setStatus(fix);
        state.debug.interactionFixed = true;
      } catch (err) {
        state.debug.drawErrors.push('恢复地图交互失败：' + messageOf(err));
      }
    }
    state.debug.mapStatus = keys.map(function (key) {
      return key + '=' + status[key];
    }).join(', ');
    state.debug.hitElement = describeMapCenterElement();
  }

  // 诊断：地图中心点命中的 DOM 元素，能看出是否有透明层盖住地图
  function describeMapCenterElement() {
    if (typeof document === 'undefined' || !document.elementFromPoint || !state.map || !state.map.getContainer) {
      return '';
    }
    try {
      var container = state.map.getContainer();
      var rect = container.getBoundingClientRect();
      if (!rect || !rect.width || !rect.height) return '地图容器尺寸为 0';
      var element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!element) return '无元素';
      var name = String(element.tagName || '').toLowerCase();
      if (element.id) name += '#' + element.id;
      var className = typeof element.className === 'string' ? element.className : '';
      if (className) name += '.' + className.split(/\s+/).join('.');
      return name + (container.contains(element) ? '（地图容器内）' : '（⚠ 地图容器外，可能吞掉手势）');
    } catch (err) {
      return '';
    }
  }

  function manualFit(beforeZoom) {
    var box = routeBounds();
    if (!box) return false;
    var zoomBefore = beforeZoom === null ? safeZoom(state.map) : beforeZoom;
    try {
      // immediately=true：不走动画，避免动画状态卡住拖动/缩放
      state.map.setBounds(new state.AMap.Bounds(box.southWest, box.northEast), true, FIT_PADDING);
      var zoomAfter = safeZoom(state.map);
      if (zoomAfter !== null && (zoomBefore === null || Math.abs(zoomAfter - zoomBefore) > 0.01)) return true;
    } catch (err) {
      state.debug.drawErrors.push('setBounds 失败：' + messageOf(err));
    }
    try {
      var center = [
        (box.southWest[0] + box.northEast[0]) / 2,
        (box.southWest[1] + box.northEast[1]) / 2,
      ];
      state.map.setZoomAndCenter(13, center, true);
      return true;
    } catch (err2) {
      state.debug.drawErrors.push('setZoomAndCenter 失败：' + messageOf(err2));
    }
    return false;
  }

  function safeCenter(map) {
    if (!map) return null;
    try {
      return map.getCenter();
    } catch (err) {
      return null;
    }
  }

  function sameCenter(a, b) {
    if (!a || !b) return false;
    try {
      return Math.abs(a.getLng() - b.getLng()) < 1e-4 && Math.abs(a.getLat() - b.getLat()) < 1e-4;
    } catch (err) {
      return false;
    }
  }

  function trimFitLog() {
    if (state.debug.fitLog && state.debug.fitLog.length > 6) {
      state.debug.fitLog.splice(0, state.debug.fitLog.length - 6);
    }
  }

  function fitOverlays(reason) {
    if (!state.map) return;
    state.debug.fitCalls = (state.debug.fitCalls || 0) + 1;
    if (!state.overlays.length) {
      // 记录「调用了但没东西可对准」，排查第二次查询不移动时能一眼看出
      state.debug.fitLog.push({
        reason: reason || '',
        skipped: '没有覆盖物',
        beforeZoom: safeZoom(state.map),
        overlays: 0,
      });
      trimFitLog();
      updateDebug();
      return;
    }
    var map = state.map;
    var beforeZoom = safeZoom(map);
    var beforeCenter = safeCenter(map);
    try {
      map.resize(); // 结果面板出现后容器尺寸变了，先重算
    } catch (err) {
      state.debug.drawErrors.push('resize 失败：' + messageOf(err));
    }
    // 放到下一帧，确保 resize 真正生效后再算视野；只跑一次，不递归
    requestAnimationFrame(function () {
      if (!state.map) return;
      try {
        map.resize();
      } catch (err) {
        state.debug.drawErrors.push('resize 失败：' + messageOf(err));
      }
      var beforeZoom2 = safeZoom(map);
      if (beforeZoom2 !== null) beforeZoom = beforeZoom2;
      var beforeCenter2 = safeCenter(map);
      if (beforeCenter2) beforeCenter = beforeCenter2;
      var box = routeBounds();
      var center = box
        ? [(box.southWest[0] + box.northEast[0]) / 2, (box.southWest[1] + box.northEast[1]) / 2]
        : null;
      var fitted = false;
      var targetZoom = null;
      var targetCenter = null;

      // 首选：自己算 zoom/center 后立即设置，避免 setFitView 的动画状态卡住手势
      try {
        if (typeof map.getFitZoomAndCenterByOverlays === 'function') {
          var fit = map.getFitZoomAndCenterByOverlays(state.overlays, FIT_PADDING, 16);
          if (fit && typeof fit[0] === 'number' && isFinite(fit[0]) && fit[1]) {
            targetZoom = fit[0];
            targetCenter = fit[1];
            map.setZoomAndCenter(fit[0], fit[1], true);
            fitted = true;
          }
        }
      } catch (err) {
        state.debug.fitError = messageOf(err);
      }
      if (!fitted) {
        try {
          // immediately=true：不走动画，避免动画状态卡住拖动/缩放
          map.setFitView(state.overlays, true, FIT_PADDING, 16);
          fitted = true;
        } catch (err2) {
          state.debug.fitError = messageOf(err2);
        }
      }

      var afterZoom = safeZoom(map);
      var atTarget = false;
      if (targetZoom !== null && afterZoom !== null && Math.abs(afterZoom - targetZoom) < 0.05) {
        atTarget = sameCenter(targetCenter, safeCenter(map));
      }
      if (afterZoom === null) {
        // 地图 zoom 已损坏（NaN/undefined）：先恢复一个可用级别，再回到路线中心
        state.debug.zoomBroken = true;
        try { map.setZoom(12, true); } catch (e1) {}
        if (center) {
          try { map.setCenter(center, true); } catch (e2) {}
        }
      } else if (box && !fitted) {
        state.debug.manualFit = manualFit(beforeZoom);
      } else if (box && !atTarget && beforeZoom !== null && Math.abs(afterZoom - beforeZoom) < 0.01) {
        // setFitView 没报错但视野没动：手动兜底
        state.debug.manualFit = manualFit(beforeZoom);
      }

      ensureMapInteractive();
      var finalZoom = safeZoom(map);
      var finalCenter = safeCenter(map);
      state.debug.fitLog.push({
        reason: reason || '',
        beforeZoom: beforeZoom,
        afterZoom: finalZoom,
        beforeCenter: describePoint(beforeCenter),
        afterCenter: finalCenter ? describePoint(finalCenter) : '',
        overlays: state.overlays.length,
        manualFit: !!state.debug.manualFit,
      });
      trimFitLog();
      state.debug.zoom = finalZoom;
      var centerNow = null;
      try { centerNow = map.getCenter(); } catch (err3) { centerNow = null; }
      state.debug.center = centerNow ? describePoint(centerNow) : '';
      updateDebug();
    });
  }

  // ------------------------------------------------------------ 调试面板

  function describePoint(point) {
    if (point === undefined || point === null) return '空';
    if (Array.isArray(point)) return '[' + point.join(', ') + ']（数组）';
    if (typeof point.getLng === 'function' && typeof point.getLat === 'function') {
      return point.getLng() + ',' + point.getLat() + '（LngLat 对象）';
    }
    if (typeof point.lng === 'number' && typeof point.lat === 'number') {
      return point.lng + ',' + point.lat + '（{lng,lat} 对象）';
    }
    if (typeof point === 'string') return point + '（字符串）';
    return String(point).slice(0, 40);
  }

  function describePath(raw) {
    if (raw === undefined) return '不存在';
    if (raw === null) return 'null';
    if (typeof raw === 'string') {
      return '字符串，长度 ' + raw.length + '，开头：' + raw.slice(0, 40);
    }
    if (Array.isArray(raw)) {
      return '数组，长度 ' + raw.length + '，首元素：' + describePoint(raw[0]);
    }
    return '类型 ' + typeof raw + '，值：' + String(raw).slice(0, 40);
  }

  function safeJson(value) {
    if (!value) return '';
    try {
      var text = JSON.stringify(value, null, 2);
      if (!text) return '';
      return text.slice(0, 8000); // 只要前 8000 字符，够看清结构
    } catch (err) {
      return 'JSON 序列化失败：' + messageOf(err);
    }
  }

  function debugReport() {
    var d = state.debug || {};
    var lines = [];
    lines.push('方案数：' + (d.planCount || 0) + '；折线：' + (d.polylineCount || 0) +
      ' 条；站点 marker：' + (d.stationMarkerCount || 0) + ' 个');
    lines.push('方案选择：' + (state.selectedPlanIndex >= 0
      ? ('第 ' + (state.selectedPlanIndex + 1) + ' / ' + state.plans.length + ' 个')
      : ('未选（共 ' + state.plans.length + ' 个）')));
    var zoomText;
    if (d.zoom === null || d.zoom === undefined || d.zoom === '') {
      zoomText = d.zoomBroken ? '无效（已尝试恢复）' : '未调整';
    } else {
      zoomText = d.zoom;
    }
    lines.push('视野：zoom ' + zoomText +
      (d.fitError ? '；setFitView 报错：' + d.fitError : '') +
      (d.manualFit ? '；已手动兜底' : '') +
      (d.zoomBroken ? '；已尝试恢复 zoom' : ''));
    lines.push('fit 调用次数：' + (d.fitCalls || 0));
    var lastFit = d.fitLog && d.fitLog.length ? d.fitLog[d.fitLog.length - 1] : null;
    if (lastFit) {
      if (lastFit.skipped) {
        lines.push('最近一次 fit（' + (lastFit.reason || '') + '）：跳过（' + lastFit.skipped +
          '），overlays=' + lastFit.overlays + '，beforeZoom=' + lastFit.beforeZoom);
      } else {
        lines.push('最近一次 fit（' + (lastFit.reason || '') + '）：zoom ' + lastFit.beforeZoom +
          ' → ' + lastFit.afterZoom + '；中心 ' + lastFit.beforeCenter + ' → ' + lastFit.afterCenter +
          '；overlays=' + lastFit.overlays + (lastFit.manualFit ? '；手动兜底' : ''));
      }
    }
    if (d.interactionFixed) lines.push('地图交互：检测到被禁用，已自动恢复');
    if (d.mapStatus) lines.push('地图状态：' + d.mapStatus);
    if (d.hitElement) lines.push('中心点元素：' + d.hitElement);
    lines.push('周边：本次消耗 ' + (d.poiRequests || 0) + ' 次周边搜索，缓存命中 ' +
      (d.poiCacheHits || 0) + ' 次；关键站 ' + (d.poiKeyCount || 0) +
      (d.poiKeyTruncated ? '（超过 8 已截断）' : '') +
      '；店铺 ' + (d.poiShopCount || 0) + ' 家，覆盖 ' + (d.poiCoveredStations || 0) +
      ' 站；整条线叠加站点 ' + (d.poiFullLineStations || 0));
    var entryRendered = !!(els.poiOpenBtn && !els.poiOpenBtn.hidden && state.selectedPlanIndex >= 0);
    lines.push('查周边入口：' + (entryRendered ? '已渲染' : '未渲染') +
      (entryRendered ? (state.poiDrawerOpen ? '（抽屉展开）' : '（抽屉收起）') : ''));
    var detailFields = d.detailFields;
    if (detailFields) {
      lines.push('详情字段：photos=' + detailFields.photos +
        ' tel=' + (detailFields.tel ? '有' : '无') +
        ' rating=' + (detailFields.rating || '无') +
        ' cost=' + (detailFields.cost || '无') +
        ' open_time=' + (detailFields.openTime ? '有' : '无') +
        '；POI keys=' + (detailFields.rawKeys || '无') +
        '；biz_ext keys=' + (detailFields.bizKeys || '无'));
    } else {
      lines.push('详情字段：尚未打开店铺');
    }
    if (d.poiErrors && d.poiErrors.length) {
      lines.push('周边错误：' + d.poiErrors.slice(0, 5).join('；'));
    }

    var plan = state.plans[0];
    if (plan) {
      var segments = planSegments(plan);
      var modes = segments.map(function (segment) { return segmentMode(segment) || '未知'; });
      lines.push('第一方案段：' + (modes.length ? modes.join(' → ') : '没有 segments'));
      var lineNames = planLineNames(plan);
      if (!lineNames.length) lines.push('  线路名：未解析到（instruction 可能为空）');
      lineNames.forEach(function (lineName) {
        lines.push('  线路 ' + lineName);
        segments.forEach(function (segment) {
          if (segmentMode(segment) === 'WALK') return;
          if (segmentLineName(segment) !== lineName) return;
          var ends = segmentStations(segment);
          lines.push('    ' + (ends.on ? ends.on.name : '?') + ' → ' + (ends.off ? ends.off.name : '?') +
            '；transit.path：' + describePath(segmentTransit(segment).path));
        });
      });
    } else {
      lines.push('没有方案数据');
    }

    if (d.segmentSlices && d.segmentSlices.length) {
      lines.push('段截取：');
      d.segmentSlices.forEach(function (sliceInfo) {
        var methodLabel = sliceInfo.method === 'arc' ? '里程法' : '下标法';
        var sText = sliceInfo.method === 'arc'
          ? ('s_on=' + Math.round(sliceInfo.sOn) + 'm，s_off=' + Math.round(sliceInfo.sOff) + 'm')
          : (sliceInfo.mileageUnavailable ? '里程法不可用' : '');
        var droppedText = sliceInfo.droppedTotal
          ? ('，丢弃 ' + sliceInfo.droppedTotal + '：' + (sliceInfo.dropped || []).join(',') +
            (sliceInfo.droppedTotal > (sliceInfo.dropped || []).length ? '…' : ''))
          : '，丢弃 0';
        lines.push('  ' + sliceInfo.lineName + '（' + methodLabel + '）：' + sText +
          '，候选 ' + sliceInfo.candidateCount + '，保留 ' + sliceInfo.keptCount +
          '，段内 ' + sliceInfo.count + droppedText +
          (sliceInfo.missing ? '（站序列缺失，只画上下车站）' : ''));
      });
    }
    if (d.viaMissing) lines.push('途经站：缺失（只画上下车站）');

    if (state.AMap) {
      lines.push('插件：LineSearch=' + typeof state.AMap.LineSearch +
        '，StationSearch=' + typeof state.AMap.StationSearch +
        '，PlaceSearch=' + typeof state.AMap.PlaceSearch);
    }
    if (d.lineSearch && d.lineSearch.length) {
      d.lineSearch.forEach(function (info) {
        if (info.status === 'hit') {
          lines.push('途经站来源：' + info.source + ' / ' + info.keyword + '，' +
            info.stations.length + ' 个站');
        } else {
          lines.push('途经站来源：四种来源均失败，途经站缺失');
        }
        (info.attempts || []).forEach(function (attempt) {
          lines.push('  [' + attempt.source + ']「' + attempt.keyword + '」status=' + attempt.status +
            '，info=' + (attempt.info || '') +
            '，原始 ' + attempt.rawCount + '，匹配 ' + attempt.matchedCount +
            '，首条 keys=' + (attempt.firstKeys || '无'));
        });
      });
    } else if (state.plans.length) {
      lines.push('途经站来源：' + (state.lineLoading ? '加载中…' : '尚未加载/未命中'));
    }
    if (d.usedStopsFallback) lines.push('兜底：用站点坐标连线（没有 transit.path）');
    if (d.usedStraightFallback) lines.push('兜底：红色虚线是起终点直线，非真实路线（解析失败）');
    if (d.failureReason) lines.push('失败原因：' + d.failureReason);
    if (d.drawErrors && d.drawErrors.length) {
      lines.push('错误：');
      d.drawErrors.forEach(function (msg) { lines.push('  - ' + msg); });
    }
    lines.push('原始 JSON：' + (state.rawJsonText.length >= 8000
      ? '前 8000 字符（已截断）'
      : state.rawJsonText.length + ' 字符') + '，见下方文本框');
    return lines.join('\n');
  }

  function updateDebug() {
    if (els.debugText) els.debugText.textContent = debugReport();
    if (els.debugJson) els.debugJson.value = state.rawJsonText || '';
  }

  // 调试区按钮：四种来源全部跑一遍，原始 status/info/字段名写进文本框
  function runViaSourceTest() {
    if (!els.testViaOutput) return;
    var query = state.lastQuery || {};
    var city = query.city || '杭州';
    var cityName = query.cityName || '杭州市';
    var lineName = query.lineName || '地铁1号线';
    var context = query.context || defaultRouteContext();
    var lines = ['=== 测试途经站来源（' + city + ' / ' + lineName + '）==='];
    lines.push('说明：这是诊断输出，不代表接口真的收录了该线路；本测试最多发起 9 次请求。');
    if (els.testViaBtn) {
      els.testViaBtn.disabled = true;
      els.testViaBtn.textContent = '测试中…';
    }
    els.testViaOutput.value = lines.join('\n');
    collectViaStations(city, cityName, lineName, context, true).then(function (result) {
      result.attempts.forEach(function (attempt, index) {
        lines.push('[' + (index + 1) + '] ' + attempt.source + '  keyword=' + JSON.stringify(attempt.keyword));
        lines.push('    status=' + attempt.status + '  info=' + (attempt.info || '') +
          '  原始条数=' + attempt.rawCount + '  匹配线路=' + attempt.matchedCount);
        lines.push('    result keys=' + (attempt.resultKeys || '无') +
          '  首条 keys=' + (attempt.firstKeys || '无') +
          '  buslines keys=' + (attempt.buslineKeys || '无'));
      });
      lines.push('');
      if (result.stations.length) {
        // 测试命中后顺手写进缓存，下一次查询直接用这条来源
        state.lineCache[lineCacheKey(city, lineName)] = {
          lineName: lineName,
          stations: result.stations,
          status: 'hit',
          source: result.source,
          keyword: result.keyword,
          attempts: result.attempts,
        };
        lines.push('结论：采用「' + result.source + ' / ' + result.keyword + '」，匹配 ' +
          result.stations.length + ' 个站。');
        lines.push('站点：' + result.stations.map(function (station) { return station.name; }).join(' → '));
      } else {
        lines.push('结论：四种来源均未拿到 ≥2 个站，主流程会显示「途经站缺失」。');
      }
      els.testViaOutput.value = lines.join('\n');
    }).catch(function (err) {
      lines.push('测试失败：' + messageOf(err));
      els.testViaOutput.value = lines.join('\n');
    }).then(function () {
      if (els.testViaBtn) {
        els.testViaBtn.disabled = false;
        els.testViaBtn.textContent = '测试途经站来源';
      }
    });
  }

  // ------------------------------------------------------------ 结果面板

  function planMetaParts(plan) {
    var minutes = Math.max(1, Math.round((Number(plan.time) || 0) / 60));
    var parts = ['约 ' + minutes + ' 分钟'];
    if (plan.distance) parts.push(formatDistance(plan.distance));
    if (plan.walking_distance) parts.push('步行 ' + formatDistance(plan.walking_distance));
    var lines = planLineNames(plan);
    if (lines.length > 1) parts.push('换乘 ' + (lines.length - 1) + ' 次');
    return { parts: parts, lines: lines };
  }

  // 多方案时列出全部方案；单方案时隐藏选择器
  function renderPlanList() {
    if (!els.planList) return;
    if (state.plans.length <= 1) {
      els.planList.innerHTML = '';
      els.planList.hidden = true;
      return;
    }
    els.planList.hidden = false;
    els.planList.innerHTML = state.plans.map(function (plan, index) {
      var selected = index === state.selectedPlanIndex;
      var meta = planMetaParts(plan);
      var color = ROUTE_COLORS[index % ROUTE_COLORS.length];
      return '<button type="button" class="plan-item' + (selected ? ' plan-selected' : '') +
        '" data-plan-index="' + index + '" aria-pressed="' + selected + '">' +
        '<span class="plan-title"><span class="plan-color" style="background:' + color + '"></span>' +
        '方案 ' + (index + 1) + (index === 0 ? '（最快捷）' : '') +
        (selected ? ' · 已选中' : '') + '</span>' +
        '<span class="plan-meta">' + escapeHtml(meta.parts.join(' · ')) +
        (meta.lines.length ? ' · ' + escapeHtml(meta.lines.join(' → ')) : '') + '</span>' +
        '</button>';
    }).join('');
  }

  function renderStationList() {
    if (!els.stationList) return;
    if (state.lineLoading) {
      els.stationList.innerHTML = '<li class="empty">正在加载途经站…</li>';
      return;
    }
    if (state.selectedPlanIndex < 0) {
      els.stationList.innerHTML = '<li class="empty">先在上方选择一个方案，再显示该方案的站点。</li>';
      return;
    }
    var list = state.poiActive && state.poiStations.length ? state.poiStations : state.stations;
    els.stationList.innerHTML = list.map(function (station) {
      var kind = stationKind(station);
      var key = poiStationKey(station);
      var extra = [];
      if (station.lines.length) extra.push(station.lines.join(' / '));
      var loadButton = state.poiActive && !state.poiQueried[key]
        ? '<button type="button" class="station-load" data-station-key="' + escapeHtml(key) + '">加载此站</button>'
        : '';
      return '<li class="station-row">' +
        '<button type="button" class="station-item" data-station-key="' + escapeHtml(key) + '">' +
        '<span class="station-name">' + escapeHtml(station.name) + '</span>' +
        '<span class="badge badge-' + kind + '">' + ROLE_LABEL[kind] + '</span>' +
        (extra.length ? '<span class="station-lines">' + escapeHtml(extra.join(' · ')) + '</span>' : '') +
        '</button>' + loadButton + '</li>';
    }).join('');
  }

  function updateSummary() {
    if (!els.resultSummary) return;
    var plans = state.plans;
    var summary = [];
    if (!plans.length) {
      els.resultSummary.textContent = '没有方案。';
      return;
    }
    var selected = state.selectedPlanIndex;
    if (plans.length === 1) {
      summary.push('高德本次只返回 1 个方案，已自动选中。');
    } else if (selected < 0) {
      summary.push('高德返回 ' + plans.length + ' 个方案，请先选择一个方案查看路线；当前地图只显示起终点。');
    } else {
      var meta = planMetaParts(plans[selected]);
      summary.push('当前方案 ' + (selected + 1) + '/' + plans.length + '：' +
        meta.parts.join(' · ') + (meta.lines.length ? ' · ' + meta.lines.join(' → ') : ''));
    }
    if (selected >= 0) {
      if (state.lineLoading) {
        summary.push('正在加载途经站…');
      } else {
        var counts = { transfer: 0, stop: 0, via: 0 };
        state.stations.forEach(function (station) { counts[stationKind(station)] += 1; });
        summary.push('换乘站 ' + counts.transfer + ' · 上下车站 ' + counts.stop + ' · 途经站 ' + counts.via);
        if (state.debug.viaMissing) summary.push('途经站缺失，只显示上下车站。');
        if (!state.stations.length) summary.push('没有解析到站点，请点开下方「调试信息」把 JSON 复制给开发者。');
        if (state.debug.usedStraightFallback) {
          summary.push('路线解析失败：地图上的红色虚线只是起终点示意，不是真实路线。');
        }
      }
    }
    els.resultSummary.textContent = summary.join(' ');
    if (els.fallbackLegend) {
      els.fallbackLegend.hidden = !(selected >= 0 && state.debug.usedStraightFallback);
    }
  }

  // 未选中方案时只画起终点（D26）
  function drawEndpointsOnly() {
    if (!state.origin || !state.dest) return;
    endpointMarker(state.origin, 'origin', '起');
    endpointMarker(state.dest, 'dest', '终');
  }

  function resetPlanDrawState() {
    state.routePoints = [];
    state.stations = [];
    state.debug.polylineCount = 0;
    state.debug.markerCount = 0;
    state.debug.stationMarkerCount = 0;
    state.debug.planPathCounts = [];
    state.debug.usedStopsFallback = false;
    state.debug.usedStraightFallback = false;
    state.debug.failureReason = '';
    state.debug.drawErrors = [];
    state.debug.manualFit = false;
    state.debug.fitError = '';
    state.debug.zoomBroken = false;
    state.debug.viaMissing = false;
    state.debug.segmentSlices = [];
  }

  // 按当前 state.lineStations 画选中方案：经过段路径 + 段内截取的站点
  function drawSelectedPlan(plan) {
    state.stations = buildStations([plan], state.lineStations);
    try {
      drawRoutes([plan], state.origin, state.dest);
    } catch (err) {
      state.debug.drawErrors.push('画路线失败：' + messageOf(err));
    }
    try {
      drawEndpointsOnly();
      drawStationMarkers(state.stations);
    } catch (err) {
      state.debug.drawErrors.push('画 marker 失败：' + messageOf(err));
    }
  }

  // 选中某个方案：先画经过段/上下车站，再加载线路站序列并截取段内途经站
  function selectPlan(index) {
    if (index < 0 || index >= state.plans.length) return;
    var plan = state.plans[index];
    var token = ++state.planLoadToken;
    state.selectedPlanIndex = index;
    state.debug.selectedPlanIndex = index;
    state.lineLoading = false;
    state.lineStations = {};
    state.debug.lineSearch = [];
    resetPoiState(); // 切换方案：清掉上一方案的整条线叠加与店铺

    // 只清路线/站点覆盖物和信息窗，不动 ToolBar / Scale 控件
    clearOverlays();
    resetPlanDrawState();
    // 先给即时反馈：经过段 + 上下车站
    drawSelectedPlan(plan);
    renderPlanList();
    renderStationList();
    updateSummary();
    updateDebug();
    renderPoiPanel();
    fitOverlays('select-start');

    var lineNames = planLineNames(plan);
    if (!lineNames.length) {
      updateSummary();
      updateDebug();
      renderPoiPanel();
      setStatus('已选中方案 ' + (index + 1) + '/' + state.plans.length + '。');
      return;
    }

    state.lineLoading = true;
    renderStationList();
    updateSummary();
    updateDebug();
    renderPoiPanel();
    setStatus('已选中方案 ' + (index + 1) + '/' + state.plans.length + '，正在加载途经站…');

    var query = state.lastQuery || {};
    var context = buildRouteContext([plan]);
    loadAllLineStations(query.city || '', query.cityName || '', lineNames, context).then(function (lineStations) {
      if (token !== state.planLoadToken || state.selectedPlanIndex !== index) return;
      state.lineStations = lineStations || {};
      state.debug.lineSearch = Object.keys(state.lineStations).map(function (name) {
        return state.lineStations[name];
      });
      state.lineLoading = false;
      clearOverlays();
      resetPlanDrawState();
      drawSelectedPlan(plan);
      renderPlanList();
      renderStationList();
      updateSummary();
      updateDebug();
      renderPoiPanel();
      fitOverlays('select-line');
      setStatus('已选中方案 ' + (index + 1) + '/' + state.plans.length + '，已画出经过段站点。');
    }).catch(function (err) {
      if (token !== state.planLoadToken || state.selectedPlanIndex !== index) return;
      state.lineLoading = false;
      state.debug.drawErrors.push('加载途经站失败：' + messageOf(err));
      clearOverlays();
      resetPlanDrawState();
      state.lineStations = {};
      drawSelectedPlan(plan);
      renderPlanList();
      renderStationList();
      updateSummary();
      updateDebug();
      renderPoiPanel();
      fitOverlays('select-line-error');
      setStatus('已选中方案，但途经站加载失败，只显示上下车站。');
    });
  }

  function showResult() {
    els.result.hidden = false;
    els.resultBody.hidden = false;
    els.resultToggle.textContent = '收起';
    els.resultToggle.setAttribute('aria-expanded', 'true');
    // 视野由 selectPlan 负责；多方案未选中时不动地图
  }

  function hideResult() {
    if (!els.result) return;
    els.result.hidden = true;
    // 结果面板收起后地图区域变大，让高德重算一次尺寸
    if (state.map) state.map.resize();
  }

  function focusStation(station) {
    if (!state.map || !station) return;
    var zoom = safeZoom(state.map);
    try {
      if (zoom !== null && zoom >= 15) {
        // 已经是近距离，只居中，不强行改缩放
        state.map.setCenter([station.lng, station.lat], true);
      } else {
        state.map.setZoomAndCenter(15, [station.lng, station.lat], true);
      }
    } catch (err) {
      state.debug.drawErrors.push('站点居中失败：' + messageOf(err));
    }
    // 先居中，再弹窗；InfoWindow 已设 autoMove:false
    openStationInfo(station);
  }

  // ------------------------------------------------------------ 主流程

  function render(data) {
    state.plans = data.plans;
    state.origin = data.origin;
    state.dest = data.dest;
    state.selectedPlanIndex = -1;
    state.debug.selectedPlanIndex = -1;
    state.planLoadToken += 1; // 取消上一次方案还没回来的线路请求
    state.lineStations = {};
    state.lineLoading = false;
    clearOverlays();
    resetPlanDrawState();
    resetPoiState();
    state.rawResult = data.raw || null;
    state.rawJsonText = safeJson(state.rawResult);
    state.debug.planCount = data.plans.length;
    state.debug.lineSearchSupported = state.AMap ? typeof state.AMap.LineSearch : 'no-AMap';
    state.debug.lineSearch = [];

    renderPlanList();
    renderStationList();
    updateSummary();
    updateDebug();
    showResult();

    if (data.plans.length === 1) {
      // 单方案：自动选中并画经过段（途经站异步补上）
      selectPlan(0);
    } else {
      // 未选中：只画起终点；每次查询都重新对准视野（第二次查询也要移动地图）
      drawEndpointsOnly();
      updateSummary();
      updateDebug();
      fitOverlays('query');
    }
    console.log('[沿线找店] 调试信息\n' + debugReport());
  }

  function setBusy(busy) {
    state.busy = busy;
    els.searchBtn.disabled = busy;
    els.searchBtn.textContent = busy ? '查询中…' : '查询换乘方案';
  }

  function doSearch() {
    if (state.busy) return;
    clearNotice();
    // 收起输入法/补全下拉，避免透明浮层盖住地图吞掉手势
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    Object.keys(state.autos).forEach(function (key) {
      var auto = state.autos[key];
      if (auto && typeof auto.hide === 'function') {
        try { auto.hide(); } catch (err) { /* 部分版本没有 hide，忽略 */ }
      }
    });
    clearResult(); // 每次新查询先清掉上一次的路线和 marker
    setBusy(true);
    setStatus('正在解析起点和终点…');

    Promise.all([resolvePlace('origin'), resolvePlace('dest')])
      .then(function (places) {
        var origin = places[0];
        var dest = places[1];
        if (!sameCity(origin, dest)) {
          throw userError('起点在「' + origin.city.label + '」，终点在「' + dest.city.label +
            '」，不在同一城市。高德公交换乘规划只支持同城，跨城暂不支持。');
        }
        setStatus('正在规划公交换乘方案…');
        return runTransfer(origin, dest).then(function (result) {
          var lineNames = collectPlanLineNames(result.plans);
          // 本阶段不收集途经站（t6 数据源留给下一步「选线查 POI」）；只记录上下文供诊断
          state.lastQuery = {
            city: result.city,
            cityName: origin.city.name || '',
            lineName: lineNames[0] || '',
            context: buildRouteContext(result.plans),
          };
          return { origin: origin, dest: dest, plans: result.plans, raw: result.raw };
        });
      })
      .then(function (data) {
        render(data);
        if (data.plans.length > 1) {
          setStatus('已取回 ' + data.plans.length + ' 个方案，请选择一个方案查看路线。');
        } else {
          setStatus('已自动选中唯一方案。');
        }
      })
      .catch(function (err) {
        setStatus('');
        showNotice(messageOf(err));
        if (!err || !err.userFacing) console.error(err);
      })
      .then(function () {
        setBusy(false);
      });
  }

  // ------------------------------------------------------------ 初始化

  function setupAutoComplete() {
    var AMap = state.AMap;
    // 2.0 里叫 AMap.AutoComplete，1.4 里叫 AMap.Autocomplete，两个名字都认
    var AutoCompleteCtor = AMap.AutoComplete || AMap.Autocomplete;
    if (!AutoCompleteCtor) {
      showNotice('地址补全插件没加载成功，只能手动输入地址后查询。');
      return;
    }
    ['origin', 'dest'].forEach(function (key) {
      var input = key === 'origin' ? els.originInput : els.destInput;
      // 不设置 city：城市从补全结果里取，不写死任何城市
      var auto = new AutoCompleteCtor({ input: input.id });
      auto.on('select', function (event) {
        var tip = event && (event.poi || event.tip || (event.name ? event : null));
        if (!tip) return;
        state.tips[key] = tip;
        if (tip.name) input.value = tip.name;
        clearNotice();
      });
      input.addEventListener('input', function () {
        // 手动改过文字，之前选中的 tip 不再可信
        state.tips[key] = null;
      });
      state.autos[key] = auto;
    });
  }

  function bindEvents() {
    els.searchBtn.addEventListener('click', doSearch);
    [els.originInput, els.destInput].forEach(function (input) {
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          doSearch();
        }
      });
    });
    if (els.stationList) {
      els.stationList.addEventListener('click', function (event) {
        var loadButton = event.target.closest ? event.target.closest('.station-load') : null;
        if (loadButton) {
          loadPoiForStationByKey(loadButton.getAttribute('data-station-key'));
          return;
        }
        var button = event.target.closest ? event.target.closest('.station-item') : null;
        if (!button) return;
        var key = button.getAttribute('data-station-key');
        var list = state.poiActive && state.poiStations.length ? state.poiStations : state.stations;
        var station = list.filter(function (item) { return poiStationKey(item) === key; })[0];
        if (station) focusStation(station);
      });
    }
    if (els.poiCategories) {
      els.poiCategories.addEventListener('change', function () {
        var checked = [];
        var boxes = els.poiCategories.querySelectorAll('input[type="checkbox"]');
        for (var i = 0; i < boxes.length; i += 1) {
          if (boxes[i].checked) checked.push(boxes[i].value);
        }
        state.poiCategories = checked;
        clearPoiNotice();
        if (state.poiActive) resetPoiResults();
      });
    }
    if (els.poiRadius) {
      els.poiRadius.addEventListener('change', function () {
        state.poiRadius = Number(els.poiRadius.value) || 800;
        if (state.poiActive) resetPoiResults();
      });
    }
    if (els.poiQueryBtn) {
      els.poiQueryBtn.addEventListener('click', runPoiForKeys);
    }
    if (els.poiOpenBtn) {
      els.poiOpenBtn.addEventListener('click', function () {
        state.poiDrawerOpen = !state.poiDrawerOpen;
        // 结果面板被「收起」时，先展开，否则抽屉藏在隐藏的 body 里
        if (state.poiDrawerOpen && els.resultBody && els.resultBody.hidden) {
          els.resultBody.hidden = false;
          els.resultToggle.textContent = '收起';
          els.resultToggle.setAttribute('aria-expanded', 'true');
          if (state.map) state.map.resize();
        }
        renderPoiPanel();
        if (state.poiDrawerOpen && els.result) els.result.scrollTop = 0;
      });
    }
    if (els.poiList) {
      els.poiList.addEventListener('click', function (event) {
        var button = event.target.closest ? event.target.closest('.poi-item') : null;
        if (!button) return;
        var shop = state.poiShops[button.getAttribute('data-shop-id')];
        if (!shop) return;
        state.map.setZoomAndCenter(15, [shop.lng, shop.lat], true);
        openShopCard(shop);
      });
    }
    if (els.shopCardClose) {
      els.shopCardClose.addEventListener('click', closeShopCard);
    }
    if (els.shopCardBackdrop) {
      els.shopCardBackdrop.addEventListener('click', closeShopCard);
    }
    if (els.shopCardCopy) {
      els.shopCardCopy.addEventListener('click', function () {
        copyTextWithFallback(state.shopCardCopyText, els.shopCardCopy, '复制店名');
      });
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeShopCard();
    });
    if (els.planList) {
      els.planList.addEventListener('click', function (event) {
        var button = event.target.closest ? event.target.closest('.plan-item') : null;
        if (!button) return;
        var index = Number(button.getAttribute('data-plan-index'));
        if (!isNaN(index)) selectPlan(index);
      });
    }
    els.resultToggle.addEventListener('click', function () {
      var wasHidden = els.resultBody.hidden;
      els.resultBody.hidden = !wasHidden;
      els.resultToggle.textContent = wasHidden ? '收起' : '展开';
      els.resultToggle.setAttribute('aria-expanded', String(wasHidden));
      state.map.resize();
      if (wasHidden) fitOverlays();
    });
    if (els.fitBtn) {
      els.fitBtn.addEventListener('click', function () {
        fitOverlays();
      });
    }
    if (els.testViaBtn) {
      els.testViaBtn.addEventListener('click', runViaSourceTest);
    }
    if (els.testViaCopy) {
      els.testViaCopy.addEventListener('click', function () {
        var text = (els.testViaOutput && els.testViaOutput.value) || '';
        var reset = function (label) {
          els.testViaCopy.textContent = label;
          setTimeout(function () { els.testViaCopy.textContent = '复制测试结果'; }, 1600);
        };
        var fallback = function () {
          if (!els.testViaOutput) return;
          els.testViaOutput.focus();
          els.testViaOutput.select();
          reset('已选中，请按 Ctrl/⌘ + C');
        };
        if (!text) {
          reset('还没有结果');
          return;
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            reset('已复制');
          }, fallback);
        } else {
          fallback();
        }
      });
    }
    if (els.debugCopy) {
      els.debugCopy.addEventListener('click', function () {
        var text = (els.debugJson && els.debugJson.value) || '';
        var reset = function (label) {
          els.debugCopy.textContent = label;
          setTimeout(function () { els.debugCopy.textContent = '复制原始 JSON'; }, 1600);
        };
        var fallback = function () {
          // 剪贴板不可用时退化为选中 textarea，让用户自己复制
          if (!els.debugJson) return;
          els.debugJson.focus();
          els.debugJson.select();
          reset('已选中，请按 Ctrl/⌘ + C');
        };
        if (!text) {
          reset('还没有 JSON');
          return;
        }
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            reset('已复制');
          }, fallback);
        } else {
          fallback();
        }
      });
    }
  }

  function setupMapControls(AMap) {
    // 缩放控件：用户必须能手动缩放；position 不被支持时退回默认位置
    if (AMap.ToolBar) {
      try {
        state.map.addControl(new AMap.ToolBar({ position: 'RB' }));
      } catch (err) {
        try {
          state.map.addControl(new AMap.ToolBar());
        } catch (err2) {
          console.warn('ToolBar 加载失败', err2);
        }
      }
    }
    if (AMap.Scale) {
      try {
        state.map.addControl(new AMap.Scale());
      } catch (err) {
        console.warn('Scale 加载失败', err);
      }
    }
  }

  function init() {
    els = {
      originInput: $('origin-input'),
      destInput: $('dest-input'),
      searchBtn: $('search-btn'),
      status: $('status'),
      notice: $('notice'),
      result: $('result'),
      resultSummary: $('result-summary'),
      resultBody: $('result-body'),
      resultToggle: $('result-toggle'),
      fitBtn: $('fit-btn'),
      fallbackLegend: $('legend-fallback'),
      planList: $('plan-list'),
      stationList: $('station-list'),
      poiPanel: $('poi-panel'),
      poiOpenBtn: $('poi-open-btn'),
      poiStats: $('poi-stats'),
      poiCategories: $('poi-categories'),
      poiRadius: $('poi-radius'),
      poiQueryBtn: $('poi-query-btn'),
      poiNotice: $('poi-notice'),
      poiList: $('poi-list'),
      shopCard: $('shop-card'),
      shopCardSheet: $('shop-card-sheet'),
      shopCardName: $('shop-card-name'),
      shopCardSub: $('shop-card-sub'),
      shopCardPhotos: $('shop-card-photos'),
      shopCardRows: $('shop-card-rows'),
      shopCardClose: $('shop-card-close'),
      shopCardBackdrop: $('shop-card-backdrop'),
      shopCardCtrip: $('shop-card-ctrip'),
      shopCardCopy: $('shop-card-copy'),
      debugText: $('debug-text'),
      debugJson: $('debug-json'),
      debugCopy: $('debug-copy'),
      testViaBtn: $('debug-test-via'),
      testViaCopy: $('debug-test-copy'),
      testViaOutput: $('debug-test-output'),
      error: $('error'),
      errorText: $('error-text'),
    };
    resetDebug();
    resetPoiState();
    bindEvents();

    // 顺序要紧：安全密钥必须在 AMapLoader.load 之前设置
    window._AMapSecurityConfig = {
      securityJsCode: (window.MAP_CONFIG && window.MAP_CONFIG.securityJsCode) || '',
    };

    if (!window.MAP_CONFIG || !window.MAP_CONFIG.key) {
      failMap('config.local.js 没加载到，或者里面没有 key。\n把 config.example.js 复制成 config.local.js 并填入真实值。');
      return;
    }
    if (typeof AMapLoader === 'undefined') {
      failMap('AMap Loader 没加载成功，检查网络是否能访问 webapi.amap.com。');
      return;
    }

    setStatus('正在加载地图…');
    AMapLoader.load({
      key: window.MAP_CONFIG.key,
      version: '2.0',
      plugins: [
        'AMap.Transfer',
        'AMap.AutoComplete',
        'AMap.PlaceSearch',
        'AMap.LineSearch',
        'AMap.StationSearch',
        'AMap.ToolBar',
        'AMap.Scale',
      ],
    })
      .then(function (AMap) {
        state.AMap = AMap;
        state.map = new AMap.Map('map', {
          zoom: 4,
          center: [104.0, 35.0], // 默认视角：全国范围；查询成功后按路线自动缩放
          viewMode: '2D',
          resizeEnable: true,
        });
        window.__map = state.map;
        setupMapControls(AMap);
        setupAutoComplete();
        setStatus('地图已就绪，输入起点和终点后点「查询换乘方案」。');
        setTimeout(function () { setStatus(''); }, 4000);
      })
      .catch(function (err) {
        failMap((err && err.message) || err);
      });
  }

  // 便于在浏览器控制台排查（也供离线单测解析/画线逻辑）
  window.__metroPoiDebug = {
    state: state,
    buildStations: buildStations,
    locateStationIndex: locateStationIndex,
    segmentSliceStations: segmentSliceStations,
    segmentArcSliceStations: segmentArcSliceStations,
    distanceMeters: distanceMeters,
    pathCumulative: pathCumulative,
    projectPointOnPath: projectPointOnPath,
    stationKind: stationKind,
    focusStation: focusStation,
    openStationInfo: openStationInfo,
    searchPoisNearStation: searchPoisNearStation,
    ensurePoiForStation: ensurePoiForStation,
    selectKeyStations: selectKeyStations,
    buildPoiStationUniverse: buildPoiStationUniverse,
    drawFullLineStage: drawFullLineStage,
    ensurePoiStage: ensurePoiStage,
    runPoiQueryForStations: runPoiQueryForStations,
    runPoiForKeys: runPoiForKeys,
    loadPoiForStationByKey: loadPoiForStationByKey,
    renderPoiMarkers: renderPoiMarkers,
    renderPoiList: renderPoiList,
    renderPoiPanel: renderPoiPanel,
    resetPoiState: resetPoiState,
    resetPoiResults: resetPoiResults,
    classifyPoi: classifyPoi,
    poiCacheKey: poiCacheKey,
    poiTypeCodes: poiTypeCodes,
    mergePoiShops: mergePoiShops,
    extractPois: extractPois,
    buildCtripUrl: buildCtripUrl,
    formatPoiCost: formatPoiCost,
    openShopCard: openShopCard,
    closeShopCard: closeShopCard,
    renderShopRows: renderShopRows,
    renderShopPhotos: renderShopPhotos,
    updateShopCardActions: updateShopCardActions,
    cityNameFromDistrict: cityNameFromDistrict,
    cityFromTip: cityFromTip,
    planSegments: planSegments,
    segmentMode: segmentMode,
    segmentLineName: segmentLineName,
    segmentStations: segmentStations,
    segmentPathPoints: segmentPathPoints,
    planLineNames: planLineNames,
    collectPlanLineNames: collectPlanLineNames,
    lineNameCandidates: lineNameCandidates,
    lineNameKey: lineNameKey,
    poiHasLine: poiHasLine,
    sortStationsByRoute: sortStationsByRoute,
    buildRouteContext: buildRouteContext,
    defaultRouteContext: defaultRouteContext,
    loadLineStations: loadLineStations,
    loadAllLineStations: loadAllLineStations,
    collectViaStations: collectViaStations,
    runLineSearch: runLineSearch,
    runStationSearch: runStationSearch,
    runPlaceKeyword: runPlaceKeyword,
    runPlaceBounds: runPlaceBounds,
    matchedStationsFromItems: matchedStationsFromItems,
    extractItems: extractItems,
    resultKeys: resultKeys,
    firstItemKeys: firstItemKeys,
    firstBuslineKeys: firstBuslineKeys,
    runViaSourceTest: runViaSourceTest,
    getEls: function () { return els; },
    render: render,
    selectPlan: selectPlan,
    renderPlanList: renderPlanList,
    renderStationList: renderStationList,
    updateSummary: updateSummary,
    planMetaParts: planMetaParts,
    clearOverlays: clearOverlays,
    planPaths: planPaths,
    normalizePath: normalizePath,
    drawRoutes: drawRoutes,
    endpointMarker: endpointMarker,
    drawStationMarkers: drawStationMarkers,
    fitOverlays: fitOverlays,
    safeZoom: safeZoom,
    ensureMapInteractive: ensureMapInteractive,
    describeMapCenterElement: describeMapCenterElement,
    setupMapControls: setupMapControls,
    debugReport: debugReport,
    safeJson: safeJson,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
