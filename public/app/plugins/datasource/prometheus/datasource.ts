// Libraries
import _ from 'lodash';
import $ from 'jquery';
import { from, Observable } from 'rxjs';
import { single, map, filter } from 'rxjs/operators';

// Services & Utils
import kbn from 'app/core/utils/kbn';
import * as dateMath from '@grafana/ui/src/utils/datemath';
import PrometheusMetricFindQuery from './metric_find_query';
import { ResultTransformer } from './result_transformer';
import PrometheusLanguageProvider from './language_provider';
import { BackendSrv } from 'app/core/services/backend_srv';
import addLabelToQuery from './add_label_to_query';
import { getQueryHints } from './query_hints';
import { expandRecordingRules } from './language_utils';

// Types
import { PromQuery, PromOptions, PromQueryRequest, PromContext } from './types';
import {
  DataQueryRequest,
  DataSourceApi,
  AnnotationEvent,
  DataSourceInstanceSettings,
  DataQueryError,
  DataStreamObserver,
  LoadingState,
} from '@grafana/ui/src/types';
import { ExploreUrlState } from 'app/types/explore';
import { safeStringifyValue } from 'app/core/utils/explore';
import { TemplateSrv } from 'app/features/templating/template_srv';
import { TimeSrv } from 'app/features/dashboard/services/TimeSrv';
import { TimeRange } from '@grafana/ui/src';

export class PrometheusDatasource extends DataSourceApi<PromQuery, PromOptions> {
  type: string;
  editorSrc: string;
  ruleMappings: { [index: string]: string };
  url: string;
  directUrl: string;
  basicAuth: any;
  withCredentials: any;
  metricsNameCache: any;
  interval: string;
  queryTimeout: string;
  httpMethod: string;
  languageProvider: PrometheusLanguageProvider;
  resultTransformer: ResultTransformer;

  /** @ngInject */
  constructor(
    instanceSettings: DataSourceInstanceSettings<PromOptions>,
    private $q: angular.IQService,
    private backendSrv: BackendSrv,
    private templateSrv: TemplateSrv,
    private timeSrv: TimeSrv
  ) {
    super(instanceSettings);

    this.type = 'prometheus';
    this.editorSrc = 'app/features/prometheus/partials/query.editor.html';
    this.url = instanceSettings.url;
    this.basicAuth = instanceSettings.basicAuth;
    this.withCredentials = instanceSettings.withCredentials;
    this.interval = instanceSettings.jsonData.timeInterval || '15s';
    this.queryTimeout = instanceSettings.jsonData.queryTimeout;
    this.httpMethod = instanceSettings.jsonData.httpMethod || 'GET';
    this.directUrl = instanceSettings.jsonData.directUrl;
    this.resultTransformer = new ResultTransformer(templateSrv);
    this.ruleMappings = {};
    this.languageProvider = new PrometheusLanguageProvider(this);
  }

  init = () => {
    this.loadRules();
  };

  getQueryDisplayText(query: PromQuery) {
    return query.expr;
  }

  _addTracingHeaders(httpOptions: any, options: any) {
    httpOptions.headers = options.headers || {};
    const proxyMode = !this.url.match(/^http/);
    if (proxyMode) {
      httpOptions.headers['X-Dashboard-Id'] = options.dashboardId;
      httpOptions.headers['X-Panel-Id'] = options.panelId;
    }
  }

  _request(url: string, data?: any, options?: any) {
    options = _.defaults(options || {}, {
      url: this.url + url,
      method: this.httpMethod,
      headers: {},
    });

    if (options.method === 'GET') {
      if (!_.isEmpty(data)) {
        options.url =
          options.url +
          '?' +
          _.map(data, (v, k) => {
            return encodeURIComponent(k) + '=' + encodeURIComponent(v);
          }).join('&');
      }
    } else {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      options.transformRequest = data => {
        return $.param(data);
      };
      options.data = data;
    }

    if (this.basicAuth || this.withCredentials) {
      options.withCredentials = true;
    }

    if (this.basicAuth) {
      options.headers.Authorization = this.basicAuth;
    }

    return this.backendSrv.datasourceRequest(options);
  }

  // Use this for tab completion features, wont publish response to other components
  metadataRequest(url: string) {
    return this._request(url, null, { method: 'GET', silent: true });
  }

  interpolateQueryExpr(value: any, variable: any, defaultFormatFn: any) {
    // if no multi or include all do not regexEscape
    if (!variable.multi && !variable.includeAll) {
      return prometheusRegularEscape(value);
    }

    if (typeof value === 'string') {
      return prometheusSpecialRegexEscape(value);
    }

    const escapedValues = _.map(value, prometheusSpecialRegexEscape);
    return escapedValues.join('|');
  }

  targetContainsTemplate(target: PromQuery) {
    return this.templateSrv.variableExists(target.expr);
  }

  processResult = (response: any, query: PromQueryRequest, target: PromQuery, responseListLength: number) => {
    // Keeping original start/end for transformers
    const transformerOptions = {
      format: target.format,
      step: query.step,
      legendFormat: target.legendFormat,
      start: query.start,
      end: query.end,
      query: query.expr,
      responseListLength,
      refId: target.refId,
      valueWithRefId: target.valueWithRefId,
    };
    const series = this.resultTransformer.transform(response, transformerOptions);

    return series;
  };

  runObserverQueries = (
    options: DataQueryRequest<PromQuery>,
    observer: DataStreamObserver,
    queries: PromQueryRequest[],
    activeTargets: PromQuery[],
    end: number
  ) => {
    for (let index = 0; index < queries.length; index++) {
      const query = queries[index];
      const target = activeTargets[index];
      let observable: Observable<any> = null;

      if (query.instant) {
        observable = from(this.performInstantQuery(query, end));
      } else {
        observable = from(this.performTimeSeriesQuery(query, query.start, query.end));
      }

      observable
        .pipe(
          single(), // unsubscribes automatically after first result
          filter((response: any) => (response.cancelled ? false : true)),
          map((response: any) => {
            return this.processResult(response, query, target, queries.length);
          })
        )
        .subscribe({
          next: series => {
            if (query.instant) {
              observer({
                key: `prometheus-${target.refId}`,
                state: LoadingState.Loading,
                request: options,
                series: null,
                delta: series,
                unsubscribe: () => undefined,
              });
            } else {
              observer({
                key: `prometheus-${target.refId}`,
                state: LoadingState.Done,
                request: options,
                series: null,
                delta: series,
                unsubscribe: () => undefined,
              });
            }
          },
        });
    }
  };

  prepareTargets = (options: DataQueryRequest<PromQuery>, start: number, end: number) => {
    const queries: PromQueryRequest[] = [];
    const activeTargets: PromQuery[] = [];

    for (const target of options.targets) {
      if (!target.expr || target.hide) {
        continue;
      }

      if (target.context === PromContext.Explore) {
        target.format = 'time_series';
        target.instant = false;
        const instantTarget: any = _.cloneDeep(target);
        instantTarget.format = 'table';
        instantTarget.instant = true;
        instantTarget.valueWithRefId = true;
        delete instantTarget.maxDataPoints;
        instantTarget.requestId += '_instant';
        instantTarget.refId += '_instant';
        activeTargets.push(instantTarget);
        queries.push(this.createQuery(instantTarget, options, start, end));
      }

      activeTargets.push(target);
      queries.push(this.createQuery(target, options, start, end));
    }

    return {
      queries,
      activeTargets,
    };
  };

  query(options: DataQueryRequest<PromQuery>, observer?: DataStreamObserver): Promise<{ data: any }> {
    const start = this.getPrometheusTime(options.range.from, false);
    const end = this.getPrometheusTime(options.range.to, true);

    options = _.clone(options);
    const { queries, activeTargets } = this.prepareTargets(options, start, end);

    // No valid targets, return the empty result to save a round trip.
    if (_.isEmpty(queries)) {
      return this.$q.when({ data: [] }) as Promise<{ data: any }>;
    }

    if (
      observer &&
      options.targets.filter(target => target.context === PromContext.Explore).length === options.targets.length
    ) {
      // using observer to make the instant query return immediately
      this.runObserverQueries(options, observer, queries, activeTargets, end);
      return this.$q.when({ data: [] }) as Promise<{ data: any }>;
    }

    const allQueryPromise = _.map(queries, query => {
      if (query.instant) {
        return this.performInstantQuery(query, end);
      } else {
        return this.performTimeSeriesQuery(query, query.start, query.end);
      }
    });

    const allPromise = this.$q.all(allQueryPromise).then((responseList: any) => {
      let result = [];

      _.each(responseList, (response, index) => {
        if (response.cancelled) {
          return;
        }

        const target = activeTargets[index];
        const query = queries[index];
        const series = this.processResult(response, query, target, queries.length);

        result = [...result, ...series];
      });

      return { data: result };
    });

    return allPromise as Promise<{ data: any }>;
  }

  createQuery(target: PromQuery, options: DataQueryRequest<PromQuery>, start: number, end: number) {
    const query: PromQueryRequest = {
      hinting: target.hinting,
      instant: target.instant,
      step: 0,
      expr: '',
      requestId: '',
      refId: '',
      start: 0,
      end: 0,
    };
    const range = Math.ceil(end - start);

    // options.interval is the dynamically calculated interval
    let interval = kbn.interval_to_seconds(options.interval);
    // Minimum interval ("Min step"), if specified for the query or datasource. or same as interval otherwise
    const minInterval = kbn.interval_to_seconds(
      this.templateSrv.replace(target.interval, options.scopedVars) || options.interval
    );
    const intervalFactor = target.intervalFactor || 1;
    // Adjust the interval to take into account any specified minimum and interval factor plus Prometheus limits
    const adjustedInterval = this.adjustInterval(interval, minInterval, range, intervalFactor);
    let scopedVars = { ...options.scopedVars, ...this.getRangeScopedVars(options.range) };
    // If the interval was adjusted, make a shallow copy of scopedVars with updated interval vars
    if (interval !== adjustedInterval) {
      interval = adjustedInterval;
      scopedVars = Object.assign({}, options.scopedVars, {
        __interval: { text: interval + 's', value: interval + 's' },
        __interval_ms: { text: interval * 1000, value: interval * 1000 },
        ...this.getRangeScopedVars(options.range),
      });
    }
    query.step = interval;

    let expr = target.expr;

    // Apply adhoc filters
    const adhocFilters = this.templateSrv.getAdhocFilters(this.name);
    expr = adhocFilters.reduce((acc, filter) => {
      const { key, operator } = filter;
      let { value } = filter;
      if (operator === '=~' || operator === '!~') {
        value = prometheusRegularEscape(value);
      }
      return addLabelToQuery(acc, key, value, operator);
    }, expr);

    // Only replace vars in expression after having (possibly) updated interval vars
    query.expr = this.templateSrv.replace(expr, scopedVars, this.interpolateQueryExpr);
    query.requestId = options.panelId + target.refId;
    query.refId = target.refId;

    // Align query interval with step to allow query caching and to ensure
    // that about-same-time query results look the same.
    const adjusted = alignRange(start, end, query.step);
    query.start = adjusted.start;
    query.end = adjusted.end;
    this._addTracingHeaders(query, options);

    return query;
  }

  adjustInterval(interval, minInterval, range, intervalFactor) {
    // Prometheus will drop queries that might return more than 11000 data points.
    // Calibrate interval if it is too small.
    if (interval !== 0 && range / intervalFactor / interval > 11000) {
      interval = Math.ceil(range / intervalFactor / 11000);
    }
    return Math.max(interval * intervalFactor, minInterval, 1);
  }

  performTimeSeriesQuery(query, start, end) {
    if (start > end) {
      throw { message: 'Invalid time range' };
    }

    const url = '/api/v1/query_range';
    const data = {
      query: query.expr,
      start: start,
      end: end,
      step: query.step,
    };
    if (this.queryTimeout) {
      data['timeout'] = this.queryTimeout;
    }
    return this._request(url, data, { requestId: query.requestId, headers: query.headers }).catch((err: any) =>
      this.handleErrors(err, query)
    );
  }

  performInstantQuery(query, time) {
    const url = '/api/v1/query';
    const data = {
      query: query.expr,
      time: time,
    };
    if (this.queryTimeout) {
      data['timeout'] = this.queryTimeout;
    }
    return this._request(url, data, { requestId: query.requestId, headers: query.headers }).catch((err: any) =>
      this.handleErrors(err, query)
    );
  }

  handleErrors = (err: any, target: PromQuery) => {
    if (err.cancelled) {
      return err;
    }

    const error: DataQueryError = {
      message: 'Unknown error during query transaction. Please check JS console logs.',
      refId: target.refId,
    };

    if (err.data) {
      if (typeof err.data === 'string') {
        error.message = err.data;
      } else if (err.data.error) {
        error.message = safeStringifyValue(err.data.error);
      }
    } else if (err.message) {
      error.message = err.message;
    } else if (typeof err === 'string') {
      error.message = err;
    }

    error.status = err.status;
    error.statusText = err.statusText;

    throw error;
  };

  performSuggestQuery(query, cache = false) {
    const url = '/api/v1/label/__name__/values';

    if (cache && this.metricsNameCache && this.metricsNameCache.expire > Date.now()) {
      return this.$q.when(
        _.filter(this.metricsNameCache.data, metricName => {
          return metricName.indexOf(query) !== 1;
        })
      );
    }

    return this.metadataRequest(url).then(result => {
      this.metricsNameCache = {
        data: result.data.data,
        expire: Date.now() + 60 * 1000,
      };
      return _.filter(result.data.data, metricName => {
        return metricName.indexOf(query) !== 1;
      });
    });
  }

  metricFindQuery(query) {
    if (!query) {
      return this.$q.when([]);
    }

    const scopedVars = {
      __interval: { text: this.interval, value: this.interval },
      __interval_ms: { text: kbn.interval_to_ms(this.interval), value: kbn.interval_to_ms(this.interval) },
      ...this.getRangeScopedVars(this.timeSrv.timeRange()),
    };
    const interpolated = this.templateSrv.replace(query, scopedVars, this.interpolateQueryExpr);
    const metricFindQuery = new PrometheusMetricFindQuery(this, interpolated, this.timeSrv);
    return metricFindQuery.process();
  }

  getRangeScopedVars(range: TimeRange) {
    range = range || this.timeSrv.timeRange();
    const msRange = range.to.diff(range.from);
    const sRange = Math.round(msRange / 1000);
    const regularRange = kbn.secondsToHms(msRange / 1000);
    return {
      __range_ms: { text: msRange, value: msRange },
      __range_s: { text: sRange, value: sRange },
      __range: { text: regularRange, value: regularRange },
    };
  }

  annotationQuery(options) {
    const annotation = options.annotation;
    const expr = annotation.expr || '';
    let tagKeys = annotation.tagKeys || '';
    const titleFormat = annotation.titleFormat || '';
    const textFormat = annotation.textFormat || '';

    if (!expr) {
      return this.$q.when([]);
    }

    const step = annotation.step || '60s';
    const start = this.getPrometheusTime(options.range.from, false);
    const end = this.getPrometheusTime(options.range.to, true);
    const queryOptions = {
      ...options,
      interval: step,
    };
    // Unsetting min interval for accurate event resolution
    const minStep = '1s';
    const query = this.createQuery({ expr, interval: minStep, refId: 'X' }, queryOptions, start, end);

    const self = this;
    return this.performTimeSeriesQuery(query, query.start, query.end).then(results => {
      const eventList = [];
      tagKeys = tagKeys.split(',');

      _.each(results.data.data.result, series => {
        const tags = _.chain(series.metric)
          .filter((v, k) => {
            return _.includes(tagKeys, k);
          })
          .value();

        const dupCheck = {};
        for (const value of series.values) {
          const valueIsTrue = value[1] === '1'; // e.g. ALERTS
          if (valueIsTrue || annotation.useValueForTime) {
            const event: AnnotationEvent = {
              annotation: annotation,
              title: self.resultTransformer.renderTemplate(titleFormat, series.metric),
              tags: tags,
              text: self.resultTransformer.renderTemplate(textFormat, series.metric),
            };

            if (annotation.useValueForTime) {
              const timestampValue = Math.floor(parseFloat(value[1]));
              if (dupCheck[timestampValue]) {
                continue;
              }
              dupCheck[timestampValue] = true;
              event.time = timestampValue;
            } else {
              event.time = Math.floor(parseFloat(value[0])) * 1000;
            }

            eventList.push(event);
          }
        }
      });

      return eventList;
    });
  }

  getTagKeys(options) {
    const url = '/api/v1/labels';
    return this.metadataRequest(url).then(result => {
      return _.map(result.data.data, value => {
        return { text: value };
      });
    });
  }

  getTagValues(options) {
    const url = '/api/v1/label/' + options.key + '/values';
    return this.metadataRequest(url).then(result => {
      return _.map(result.data.data, value => {
        return { text: value };
      });
    });
  }

  testDatasource() {
    const now = new Date().getTime();
    return this.performInstantQuery({ expr: '1+1' }, now / 1000).then(response => {
      if (response.data.status === 'success') {
        return { status: 'success', message: 'Data source is working' };
      } else {
        return { status: 'error', message: response.error };
      }
    });
  }

  getExploreState(queries: PromQuery[]): Partial<ExploreUrlState> {
    let state: Partial<ExploreUrlState> = { datasource: this.name };
    if (queries && queries.length > 0) {
      const expandedQueries = queries.map(query => ({
        ...query,
        expr: this.templateSrv.replace(query.expr, {}, this.interpolateQueryExpr),
        context: 'explore',

        // null out values we don't support in Explore yet
        legendFormat: null,
        step: null,
      }));
      state = {
        ...state,
        queries: expandedQueries,
      };
    }
    return state;
  }

  getQueryHints(query: PromQuery, result: any[]) {
    return getQueryHints(query.expr || '', result, this);
  }

  loadRules() {
    this.metadataRequest('/api/v1/rules')
      .then(res => res.data || res.json())
      .then(body => {
        const groups = _.get(body, ['data', 'groups']);
        if (groups) {
          this.ruleMappings = extractRuleMappingFromGroups(groups);
        }
      })
      .catch(e => {
        console.log('Rules API is experimental. Ignore next error.');
        console.error(e);
      });
  }

  modifyQuery(query: PromQuery, action: any): PromQuery {
    let expression = query.expr || '';
    switch (action.type) {
      case 'ADD_FILTER': {
        expression = addLabelToQuery(expression, action.key, action.value);
        break;
      }
      case 'ADD_HISTOGRAM_QUANTILE': {
        expression = `histogram_quantile(0.95, sum(rate(${expression}[5m])) by (le))`;
        break;
      }
      case 'ADD_RATE': {
        expression = `rate(${expression}[5m])`;
        break;
      }
      case 'ADD_SUM': {
        expression = `sum(${expression.trim()}) by ($1)`;
        break;
      }
      case 'EXPAND_RULES': {
        if (action.mapping) {
          expression = expandRecordingRules(expression, action.mapping);
        }
        break;
      }
      default:
        break;
    }
    return { ...query, expr: expression };
  }

  getPrometheusTime(date, roundUp) {
    if (_.isString(date)) {
      date = dateMath.parse(date, roundUp);
    }
    return Math.ceil(date.valueOf() / 1000);
  }

  getTimeRange(): { start: number; end: number } {
    const range = this.timeSrv.timeRange();
    return {
      start: this.getPrometheusTime(range.from, false),
      end: this.getPrometheusTime(range.to, true),
    };
  }

  getOriginalMetricName(labelData) {
    return this.resultTransformer.getOriginalMetricName(labelData);
  }
}

/**
 * Align query range to step.
 * Rounds start and end down to a multiple of step.
 * @param start Timestamp marking the beginning of the range.
 * @param end Timestamp marking the end of the range.
 * @param step Interval to align start and end with.
 */
export function alignRange(start: number, end: number, step: number): { end: number; start: number } {
  const alignedEnd = Math.floor(end / step) * step;
  const alignedStart = Math.floor(start / step) * step;
  return {
    end: alignedEnd,
    start: alignedStart,
  };
}

export function extractRuleMappingFromGroups(groups: any[]) {
  return groups.reduce(
    (mapping, group) =>
      group.rules
        .filter(rule => rule.type === 'recording')
        .reduce(
          (acc, rule) => ({
            ...acc,
            [rule.name]: rule.query,
          }),
          mapping
        ),
    {}
  );
}

export function prometheusRegularEscape(value) {
  if (typeof value === 'string') {
    return value.replace(/'/g, "\\\\'");
  }
  return value;
}

export function prometheusSpecialRegexEscape(value) {
  if (typeof value === 'string') {
    return prometheusRegularEscape(value.replace(/\\/g, '\\\\\\\\').replace(/[$^*{}\[\]+?.()|]/g, '\\\\$&'));
  }
  return value;
}
