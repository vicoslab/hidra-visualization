var app = {
    critical: {red: 350, orange: 330, yellow: 300},
    maxRuns: 30,
    apiHosts: [
        'https://gea.arso.gov.si',
        'https://meteo.arso.gov.si'
    ]
};

function showError() {
    // hide plot-placeholder div
    $('#plot-placeholder').hide();
    $('#error-placeholder').show();
}

function fetchJson(url) {
    return fetch(url)
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to fetch ' + url);
            }

            return response.json();
        });
}

function fetchJsonWithFallback(urls) {
    let lastError;

    return urls.reduce((promise, url) => {
        return promise.catch(() => fetchJson(url).catch(error => {
            lastError = error;
            return Promise.reject(error);
        }));
    }, Promise.reject())
        .catch(() => Promise.reject(lastError));
}

function buildApiUrls(path) {
    return app.apiHosts.map(host => host + path);
}

function buildFallbackDates() {
    let dates = [];
    let referenceDate = moment().startOf('day');

    for (let i = app.maxRuns - 1; i >= 0; i--) {
        dates.push(referenceDate.clone().subtract(i, 'days').format('YYYYMMDD00'));
    }

    return dates;
}

function getDataField(data, keys, fallback = []) {
    if (!data) {
        return fallback;
    }

    for (const key of keys) {
        if (data[key] !== undefined) {
            return data[key];
        }
    }

    return fallback;
}

function getDateList(data) {
    if (Array.isArray(data)) {
        return data;
    }

    return getDataField(data, ['Dates', 'dates']);
}

function getStdList(data) {
    return getDataField(data, ['std', 'stds', 'Std', 'Stds']);
}

function getValueList(data) {
    return getDataField(data, ['Values', 'values']);
}

// Fetch dates from server
function getDates() {
    return fetchJsonWithFallback(buildApiUrls('/vg2020-dev/hidra/listHIDRAjson'))
        .then(data => {
            // Select last N runs
            let dates = getDateList(data).slice(-app.maxRuns);

            if (dates.length === 0) {
                return Promise.resolve(buildFallbackDates());
            }

            return Promise.resolve(dates);
        })
        .catch(() => Promise.resolve(buildFallbackDates()));
}

// Fetch a single run from server
function getRun(date) {
    return fetchJsonWithFallback(buildApiUrls('/vg2020-dev/hidra/showHIDRAjson?date=' + date));
}

function getSSH() {
    return fetchJsonWithFallback(buildApiUrls('/vg2020-dev/hidra/showKPjson'));
}

function parseDate(date) {
    return moment(date, [moment.ISO_8601, "DD.MM.YYYY HH:mm", "DD.MM.YYYY hh:mm", "YYYYMMDDHH"]).format();
}

function average(vals) {
    let sum = vals.reduce((sum, v) => sum + v);
    return sum / vals.length;
}

function std_average(y, std) {
    let std_squared = std.map(v => v * v);
    let y_squared = y.map(v => v * v);
    let sum = std_squared.map((v, i) => v + y_squared[i]);
    let mean = average(sum);
    let y_mean = average(y);
    return Math.sqrt(mean - y_mean * y_mean);
}

function stddev(vals) {
    let m = average(vals);
    let sqDiffs = vals.map(v => (v - m) * (v - m));

    return Math.sqrt(average(sqDiffs));
}

// Called when different run is selected
function selectDate(e) {
    let frame = app.frames.find((f) => f.name == e.step.value);

    Plotly.animate(app.plot, [frame.data_frame], {
        mode: 'immediate',
        frame: {duration: 0, redraw: false},
    }).then(() => {
        app.plot._fullLayout.xaxis._rangeInitial = frame.date_range;

        // autoscale
        Plotly.relayout(app.plot, {yaxis: {fixedrange: true}});

        return Plotly.animate(app.plot, [frame.animation_frame], {
            mode: 'immediate',
            transition: {duration: 500, easing: 'exp-out'},
            frame: {duration: 500, redraw: false},
        })
    }).then(() => {

    });
}

// Loads data from server into the app
function fetchData() {

    let runs = getDates()
        .then(dates => {
            dates = [...new Set(dates)].sort();
            app.dates = dates;
            let promises = dates.map(date => getRun(date)
                .then(run => ({date: date, run: run}))
                .catch(() => null));

            return Promise.all(promises)
                .then(results => results.filter(result => result !== null));
        });

    let ssh = getSSH().catch(() => null);

    return Promise.all([runs, ssh])
        .then(data => {
            let runs_data = data[0];
            let ssh_data = data[1];

            if (runs_data.length === 0) {
                return Promise.reject();
            }

            let ssh = [];
            let ssh_dates = [];

            if (ssh_data !== null) {
                ssh = getValueList(ssh_data);
                ssh_dates = getDateList(ssh_data).map(val => parseDate(val));
            }

            let predictions = [];
            for ({date, run: d} of runs_data) {
                let predictionDates = getDateList(d);
                let hidra = getDataField(d, ['Hidra', 'hidra']);

                let ys = [];
                let stddevs = [];

                let predictionLength = predictionDates.length;

                for (let i = 0; i < predictionLength; i++) {
                    let y_i = [];
                    let std_i = [];

                    for (let j = 0; j < hidra.length; j++) {
                        let values = getValueList(hidra[j]);
                        if (i >= values.length) {
                            continue;
                        }

                        y_i.push(values[i]);
                        let std = getStdList(hidra[j]);
                        std_i.push(i < std.length ? std[i] : 0);
                    }

                    ys.push(y_i.length > 0 ? average(y_i) : null);
                    stddevs.push(y_i.length > 0 ? std_average(y_i, std_i) : 0);
                }
                // console.log(ys);
                // console.log(stddevs);

                let pred = {
                    date: parseDate(getDataField(d, ['ForecastDate', 'forecastDate'], date)),
                    x: predictionDates.map(val => parseDate(val)),
                    y: ys,
                    stddev: stddevs,
                };

                predictions.push(pred);
                // console.log(pred);
            }

            app.data = {
                ssh: {
                    x: ssh_dates,
                    y: ssh
                },
                predictions: predictions
            };

            return Promise.resolve();
        })
        .catch(error => {
            showError();
            return Promise.reject(error);
        });
}

// Loads the plot
function initPlot() {

    // FRAMES
    app.frames = app.data.predictions.map((pred, i) => {
        let start_date = moment(pred.x[0]).subtract(24, 'hours').format();
        let pred_start = pred.x[0];
        let end_date = pred.x[pred.x.length - 1];

        let yMax = pred.y.map((y, i) => y + 2 * pred.stddev[i]);
        let yMin = pred.y.map((y, i) => y - 2 * pred.stddev[i]);

        return {
            name: pred.date,
            date_range: [start_date, end_date],
            data_frame: {
                data: [{
                    x: pred.x,
                    y: pred.y
                }, {
                    x: pred.x,
                    y: yMax,
                }, {
                    x: pred.x,
                    y: yMin,
                }],
                layout: {
                    shapes: [
                        {
                            type: 'rect',
                            xref: 'x',
                            yref: 'paper',
                            x0: start_date,
                            y0: 0,
                            x1: pred_start,
                            y1: 1,
                            fillcolor: '#d3d3d3',
                            opacity: 0.2,
                            line: {
                                width: 0
                            }
                        }]
                }
            },
            animation_frame: {
                layout: {xaxis: {range: [start_date, end_date]}}
            }
        };
    });

    // SLIDER
    let slider_vals = app.data.predictions.map((pred, i) => {
        return {
            label: pred.date,
            method: 'skip'
        };
    });
    let last_i = slider_vals.length - 1;

    // DATA
    let pred = app.data.predictions[app.data.predictions.length - 1];
    let start_date = moment(pred.x[0]).subtract(24, 'hours').format();
    let pred_start = pred.x[0];
    let end_date = pred.x[pred.x.length - 1];

    let yMax = pred.y.map((y, i) => y + 2 * pred.stddev[i]);
    let yMin = pred.y.map((y, i) => y - 2 * pred.stddev[i]);

    let data = [{
        x: pred.x,
        y: pred.y,
        name: app.localization.localize("HIDRA3 napoved", app.lang),
        legendgroup: 'predictions',
        // line: {shape: 'spline', smoothing: 1.3}
    },
        {
            x: pred.x,
            y: yMax,
            legendgroup: 'predictions',
            hoverinfo: 'none',
            showlegend: false,
            // line: {width: 0, color: '#1f77b4', shape: 'spline', smoothing: 1.3},
            line: {width: 0, color: '#1f77b4'},
        },
        {
            x: pred.x,
            y: yMin,
            legendgroup: 'predictions',
            hoverinfo: 'none',
            showlegend: false,
            // line: {width: 0, color: '#1f77b4', shape: 'spline', smoothing: 1.3},
            line: {width: 0, color: '#1f77b4'},
            fill: 'tonexty'
        },
        {
            x: app.data.ssh.x,
            y: app.data.ssh.y,
            name: app.localization.localize("Izmerjena višina", app.lang),
            line: {color: 'black'}
        }];

    // LAYOUT
    let layout = {
        margin: {t: 40},
        xaxis: {range: [start_date, end_date]},
        yaxis: {fixedrange: true, title: {text: app.localization.localize("Višina [cm]", app.lang)}},
        dragmode: 'pan',
        shapes: [{
            type: 'rect',
            xref: 'x',
            yref: 'paper',
            x0: start_date,
            y0: 0,
            x1: pred_start,
            y1: 1,
            fillcolor: '#d3d3d3',
            opacity: 0.2,
            line: {
                width: 0
            }
        }, {
            type: 'line',
            x0: 0,
            x1: 1,
            y0: app.critical.red,
            y1: app.critical.red,
            xref: 'paper',
            line: {
                color: 'red',
                width: 1.5,
                dash: 'dot'
            }
        }, {
            type: 'line',
            x0: 0,
            x1: 1,
            y0: app.critical.orange,
            y1: app.critical.orange,
            xref: 'paper',
            line: {
                color: 'orange',
                width: 1.5,
                dash: 'dot'
            }
        }, {
            type: 'line',
            x0: 0,
            x1: 1,
            y0: app.critical.yellow,
            y1: app.critical.yellow,
            xref: 'paper',
            line: {
                color: 'yellow',
                width: 1.5,
                dash: 'dot'
            }
        }],
        sliders: [{
            pad: {t: 70},
            active: last_i,
            currentvalue: {
                xanchor: 'right',
                prefix: app.localization.localize("Datum napovedi: ", app.lang),
                font: {
                    color: '#888',
                    size: 20
                }
            },
            steps: slider_vals
        }]
    };

    Plotly.newPlot(app.plot, {
        data: data,
        layout: layout,
        config: {responsive: true, locale: app.lang}
    }).then(() => {
        app.placeholder.parentNode.removeChild(app.placeholder);
    });

    app.plot.on('plotly_sliderchange', selectDate);
}

// When ready, load data and display plot
window.onload = function () {
    app.localization = localization;
    app.lang = document.getElementById('app-script').getAttribute('data-lang')
    app.plot = document.getElementById('plot');
    app.placeholder = document.getElementById('plot-placeholder');

    // Populate date selection
    fetchData()
        .then(() => initPlot());
}
