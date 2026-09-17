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
    const limits = {GeneratedAt: 36, LatestForecastAt: 36, LatestGaugeAt: 36};
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

            let predictions = [];
            for (const d of runs_data) {

                let ys = [];
                let stddevs = [];

                for (let i = 0; i < 72; i++) {
                    let y_i = [];
                    let std_i = [];

                    for (let j = 0; j < d.Hidra.length; j++) {
                        y_i.push(d.Hidra[j].values[i]);
                        std_i.push(d.Hidra[j].std[i]);
                    }

                    ys.push(average(y_i));
                    stddevs.push(std_average(y_i, std_i));
                }
                // console.log(ys);
                // console.log(stddevs);

                let pred = {
                    date: d.ForecastDate,
                    x: d.Dates.map(val => parseDate(val)),
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

    return Plotly.newPlot(app.plot, {
        data: data,
        layout: layout,
        config: {responsive: true, locale: app.lang}
    }).then(() => {
        app.placeholder.parentNode.removeChild(app.placeholder);
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
        .catch(() => showError());
}
