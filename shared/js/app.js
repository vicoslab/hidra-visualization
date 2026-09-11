var app = {
    critical: {red: 350, orange: 330, yellow: 300},
    maxRuns: 30
};

function showError() {
    const placeholder = document.getElementById('plot-placeholder');
    if (placeholder) placeholder.style.display = 'none';
    document.getElementById('error-placeholder').style.display = 'block';
}

// Data is published with this site. No API credentials or ARSO calls in browsers.
function getJSON(path) {
    return fetch('../shared/data/' + path, {cache: 'no-store', credentials: 'omit'})
        .then(response => {
            if (!response.ok) throw new Error('Data request failed');
            return response.json();
        });
}

function updateStaleWarning() {
    const data = app.manifest || {};
    const limits = {GeneratedAt: 3, LatestForecastAt: 36, LatestGaugeAt: 3};
    const stale = Object.keys(limits).some(key => {
        const value = Date.parse(data[key]);
        return !Number.isFinite(value) || Date.now() - value > limits[key] * 3600000;
    });
    const warning = document.getElementById('stale-warning');
    warning.textContent = app.localization.localize('stale', app.lang);
    warning.hidden = !stale;
}

function getDates() {
    return getJSON('dates.json').then(data => {
        if (!Array.isArray(data.Dates) || !data.Dates.length ||
            data.Dates.some(date => typeof date !== 'string' || !/^[0-9]{10}$/.test(date))) {
            throw new Error('Invalid run manifest');
        }
        app.manifest = data;
        updateStaleWarning();
        return data.Dates.slice().sort().slice(-app.maxRuns);
    });
}

function getRun(date) {
    if (!/^[0-9]{10}$/.test(date)) return Promise.reject(new Error('Invalid run ID'));
    return getJSON('runs/Hidra_' + date + '.json');
}

function getSSH() {
    return getJSON('mareografKP_vodostaj.json');
}

function parseDate(date) {
    return moment(date, "DD.MM.YYYY HH:mm", true).format('YYYY-MM-DDTHH:mm:ss');
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
    app.selection = (app.selection || 0) + 1;
    app.archivePrediction = null;
    app.archiveSSH = null;
    archiveStatus('archiveHelp');
    Plotly.restyle(app.plot, {x: [app.data.ssh.x], y: [app.data.ssh.y]}, [3]);
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
            dates.sort();
            app.dates = dates;
            let promises = dates.map(date => getRun(date));
            return Promise.all(promises);
        });

    let ssh = getSSH();

    return Promise.all([runs, ssh])
        .then(data => {
            let runs_data = data[0];
            let ssh_data = data[1];

            let ssh = ssh_data.Values;
            let ssh_dates = ssh_data.Dates.map(val => parseDate(val));

            const predictions = runs_data.map(prediction);

            app.data = {
                ssh: withMeasurementGaps({x: ssh_dates, y: ssh}),
                predictions: predictions
            };

            return Promise.resolve();
        });
}

// The index is small; historical forecast and measurement months load only on demand.
function setupArchive() {
    return getJSON('archive/index.json').then(index => {
        if (index.Version !== 1 || !Array.isArray(index.Dates) || !index.Dates.length ||
            index.Dates.some(id => !/^[0-9]{10}$/.test(id)) || !Array.isArray(index.GaugeMonths) ||
            index.GaugeMonths.some(month => !/^[0-9]{4}(0[1-9]|1[0-2])$/.test(month))) {
            throw new Error('Invalid archive index');
        }
        app.archiveIndex = index;
        const date = document.getElementById('archive-date');
        const runs = document.getElementById('archive-run');
        const toDate = id => id.slice(0,4) + '-' + id.slice(4,6) + '-' + id.slice(6,8);
        date.min = toDate(index.Dates[0]);
        date.max = toDate(index.Dates[index.Dates.length - 1]);
        date.value = date.max;
        const populate = () => {
            runs.replaceChildren();
            const ids = index.Dates.filter(id => toDate(id) === date.value);
            for (const id of ids) {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = id.slice(8) + ':00 — ' + id;
                runs.appendChild(option);
            }
            runs.disabled = !ids.length;
            archiveStatus(ids.length ? 'archiveHelp' : 'archiveEmpty');
            if (ids.length) runs.value = ids[ids.length - 1];
        };
        date.addEventListener('change', () => {
            populate();
            if (!runs.disabled) selectArchiveRun(runs.value);
        });
        runs.addEventListener('change', () => selectArchiveRun(runs.value));
        document.getElementById('latest-button').addEventListener('click', showLatest);
        populate();
    });
}

function withMeasurementGaps(ssh) {
    const result = {x: [], y: []};
    ssh.x.forEach((date, i) => {
        // Embedded historical observations are hourly; never bridge outages over 2h.
        if (i && moment(date).diff(moment(ssh.x[i - 1]), 'minutes') > 120) {
            result.x.push(date);
            result.y.push(null);
        }
        result.x.push(date);
        result.y.push(ssh.y[i]);
    });
    return result;
}

function archiveStatus(key, suffix = '') {
    document.getElementById('archive-status').textContent = app.localization.localize(key, app.lang) + suffix;
}

function prediction(data) {
    // Compact snapshots have the same mixture mean/std as the original ensembles.
    const members = data.Hidra || [{values: data.Mean, std: data.Std}];
    const mean = [], std = [];
    for (let i = 0; i < 72; i++) {
        mean.push(average(members.map(member => member.values[i])));
        std.push(members.length === 1 ? members[0].std[i] : std_average(
            members.map(member => member.values[i]), members.map(member => member.std[i])));
    }
    if (data.Dates.length !== 72 || mean.some(v => !Number.isFinite(v)) ||
        std.some(v => !Number.isFinite(v) || v < 0)) throw new Error('Invalid forecast');
    return {date: data.ForecastDate, x: data.Dates.map(parseDate), y: mean, stddev: std};
}

async function selectArchiveRun(id) {
    const selection = app.selection = (app.selection || 0) + 1;
    try {
        if (!app.archiveIndex.Dates.includes(id)) throw new Error('Unknown archive run');
        archiveStatus('archiveLoading');
        const month = id.slice(0,4) + '/' + id.slice(4,6);
        const runs = await getJSON('archive/runs/' + month + '.json');
        const pred = prediction(runs[id]);
        const start = moment(pred.x[0]).subtract(24, 'hours');
        const end = moment(pred.x[pred.x.length - 1]);
        const months = app.archiveIndex.GaugeMonths.filter(m => m >= start.format('YYYYMM') && m <= end.format('YYYYMM'));
        const measurements = await Promise.all(months.map(m => getJSON('archive/gauges/' + m.slice(0,4) + '/' + m.slice(4) + '.json')));
        const ssh = {x: [], y: []};
        for (const gauge of measurements) {
            gauge.Dates.forEach((date, i) => {
                const parsed = parseDate(date);
                if (parsed >= start.format('YYYY-MM-DDTHH:mm:ss') && parsed <= end.format('YYYY-MM-DDTHH:mm:ss')) {
                    ssh.x.push(parsed);
                    ssh.y.push(gauge.Values[i]);
                }
            });
        }
        if (selection !== app.selection) return; // A slower request must not replace a newer choice.
        app.archivePrediction = pred;
        app.archiveSSH = withMeasurementGaps(ssh);
        document.getElementById('error-placeholder').style.display = 'none';
        await initPlot();
        archiveStatus('archiveSelected', id + ' — ' + pred.date);
    } catch (_) {
        if (selection === app.selection) {
            archiveStatus('archiveFailed');
            showError();
        }
    }
}

function showLatest() {
    app.selection = (app.selection || 0) + 1;
    app.archivePrediction = null;
    app.archiveSSH = null;
    archiveStatus('archiveHelp');
    document.getElementById('error-placeholder').style.display = 'none';
    return initPlot().catch(showError);
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
            name: app.dates[i],
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
            value: app.dates[i],
            method: 'skip'
        };
    });
    let last_i = slider_vals.length - 1;

    // DATA
    let pred = app.archivePrediction || app.data.predictions[app.data.predictions.length - 1];
    const ssh = app.archiveSSH || app.data.ssh;
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
            x: ssh.x,
            y: ssh.y,
            connectgaps: false,
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
        sliders: app.archivePrediction ? [] : [{
            pad: {t: 70},
            active: app.archivePrediction ? -1 : last_i,
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

    return Plotly.newPlot(app.plot, {
        data: data,
        layout: layout,
        config: {responsive: true, locale: app.lang}
    }).then(() => {
        if (app.placeholder && app.placeholder.parentNode) {
            app.placeholder.parentNode.removeChild(app.placeholder);
            app.placeholder = null;
        }
        app.plot.on('plotly_sliderchange', selectDate);
    });
}

// When ready, load data and display plot
window.onload = function () {
    app.localization = localization;
    app.lang = document.getElementById('app-script').getAttribute('data-lang')
    app.plot = document.getElementById('plot');
    app.placeholder = document.getElementById('plot-placeholder');

    // Populate date selection
    setInterval(updateStaleWarning, 60000);
    return fetchData()
        .then(() => initPlot())
        .then(() => setupArchive())
        .catch(() => showError());
}
