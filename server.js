"use strict";

// Load the web-server, file-system and file-path modules.
var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var url_methods = require('url');
var sql = require("sqlite3").verbose();
var formidable = require('formidable');
var bcrypt = require('bcrypt');
var qs = require('querystring');

var file = "westory.db";
var exists = fs.existsSync(file);
var db = new sql.Database(file);

const saltRounds = 10;

// App modules
var server_book = require("./server-book.js");
var serverCharacter = require("./server-character.js");

var ipAddress = 'localhost'; //127.0.0.1

var session = function() {
    username = "guest";
    secret = "";
}

// Manage sessions using database
var cachedImages = {};

// The default port numbers are the standard ones [80,443] for convenience.
// Change them to e.g. [8080,8443] to avoid privilege or clash problems.
var ports = [80, 443];

// The most common standard file extensions are supported.
// The most common non-standard file extensions are excluded, with a message.
var types = {
    '.html' : 'text/html, application/xhtml+xml',
    '.css'  : 'text/css',
    '.js'   : 'application/javascript',
    '.png'  : 'image/png',
    '.mp3'  : 'audio/mpeg', // audio
    '.aac'  : 'audio/aac',  // audio
    '.mp4'  : 'video/mp4',  // video
    '.webm' : 'video/webm', // video
    '.gif'  : 'image/gif',  // only if imported unchanged
    '.jpeg' : 'image/jpeg', // only if imported unchanged
    '.svg'  : 'image/svg+xml',
    '.json' : 'application/json',
    '.pdf'  : 'application/pdf',
    '.txt'  : 'text/plain', // plain text only
    '.ttf'  : 'application/x-font-ttf',
    '.xhtml': '#not suitable for dual delivery, use .html',
    '.htm'  : '#proprietary, non-standard, use .html',
    '.jpg'  : '#common but non-standard, use .jpeg',
    '.rar'  : '#proprietary, non-standard, platform dependent, use .zip',
    '.docx' : '#proprietary, non-standard, platform dependent, use .pdf',
    '.doc'  : '#proprietary, non-standard, platform dependent, ' +
              'closed source, unstable over versions and installations, ' +
              'contains unsharable personal and printer preferences, use .pdf',
    '.ico'  : 'image/x-icon'
};

// Start both the http and https services.  Requests can only come from
// localhost, for security.  (This can be changed to a specific computer, but
// shouldn't be removed, otherwise the site becomes public.)
function start() {
    test();
    var httpService = http.createServer(function(request, response) {
        // redirect to secure connection
        response.writeHead(301, {"Location": "https://" + request.headers['host']+request.url});
        response.end();
    });
    httpService.listen(ports[0], 'localhost');
    var options = { key: key, cert: cert };
    var httpsService = https.createServer(options, serve);
    httpsService.listen(ports[1], 'localhost');
    // turn on foreign key constraints
    db.run(
        "PRAGMA foreign_keys = ON"
    , dbErr);
    printAddresses();
}

// Print out the server addresses.
function printAddresses() {
    var httpAddress = "http://localhost";
    if (ports[0] != 80) httpAddress += ":" + ports[0];
    httpAddress += "/";
    var httpsAddress = "https://localhost";
    if (ports[1] != 443) httpsAddress += ":" + ports[1];
    httpsAddress += "/";
    console.log('Server running at', httpAddress, 'and', httpsAddress);
}

// Response codes: see http://en.wikipedia.org/wiki/List_of_HTTP_status_codes
var OK = 200, Redirect = 307, NotFound = 404, BadType = 415, Error = 500, BadRequest = 400; // 418 I'm a teapot

// Succeed, sending back the content and its type.
function succeed(response, type, content) {
    var typeHeader = { 'Content-Type': type };
    response.writeHead(OK, typeHeader);
    response.write(content);
    response.end();
}

// Tell the browser to try again at a different URL.
function redirect(response, url) {
    var locationHeader = { 'Location': url };
    response.writeHead(Redirect, locationHeader);
    response.end();
}

// Give a failure response with a given code.
function fail(response, code) {
    response.writeHead(code);
    response.end();
}

function GetSecret(request) {
    // Parse cookies from request
    var list = {};
    var rc = request.headers.cookie;
    if (rc)
    {
        rc = rc.split(';').forEach(function(cookie){
            var parts = cookie.split('=');
            list[parts.shift().trim()] = decodeURI(parts.join('='));
        });
    }

    return list['secret'];
}

// Serve a single request.  A URL ending with / is treated as a folder and
// index.html is added.  A file name without an extension is reported as an
// error (because we don't know how to deliver it, or if it was meant to be a
// folder, it would inefficiently have to be redirected for the browser to get
// relative links right).
function serve(request, response) {
    // secret for guests will remain an empty string
    var secret = '';
    // get secret from cookies
    var cookie_secret = GetSecret(request);
    var session = { "secret" : secret };
    // Check for expired sessions
    //db.run("DELETE FROM Sessions WHERE date <= datetime('now','-6 hour')", function(e) {
    db.run("DELETE FROM Sessions WHERE date <= datetime('now','-5 minute')", function(e) {
        if (e) throw e;
        // Check if there is existing session
        db.all("SELECT * FROM Sessions WHERE secret = '"+cookie_secret+"'", function(err, row) {
            // Set secret if found, otherwise leave as empty string
            if (row[0])
            {
                session = row[0];
                secret = session['secret'];
                response.setHeader('Set-Cookie', ['secret='+secret]);
            }

            var file = "/public"+request.url;
            if (ends(file,'/')) file = file + 'index.html';
            // If there are parameters, take them off
            var parts = file.split("?");
            if (parts.length > 1) file = parts[0];
            file = "." + file;

            var type = findType(request, path.extname(file));

            // Content Negotiation
            // For the .html extension:
            var otype = "text/html";
            var ntype = "application/xhtml+xml";
            var header = request.headers.accept;
            var accepts = header.split(",");
            if (accepts.indexOf(ntype) >= 0) type = ntype;
            else if (accepts.indexOf(otype) >= 0) type = otype;

            // URL Validation
            var urlValidation = new RegExp("\\.\\.|//|/\\.");
            var urlInvalid = urlValidation.test(request.url.toLowerCase());
            if (urlInvalid)
            {
                console.log("Invalid URL: "+request.url.toLowerCase());
                return fail(response, BadRequest);
            }

            if (! type) return fail(response, BadType);
            if (! inSite(file)) return fail(response, NotFound);
            if (! matchCase(file)) return fail(response, NotFound);
            if (! noSpaces(file)) return fail(response, NotFound);
            try { fs.readFile(file, ready); }
            catch (err) { return fail(response, Error); }
            
            function ready(error, content) {
                if (error) return fail(response, NotFound);
                // Deal with request
                if(!handleRequest(request,response,session))
                    succeed(response,type,content);
            }
        });
    });
}

function handleRequest(request,response,session) {
    if (request.method.toLowerCase() == 'post') { 
        if(request.url.toLowerCase() == '/register-login.html'){
            registerOrLogin(request, response);
            return true;
        } else if(url_methods.parse(request.url).pathname === '/character-creator.html') {
            var params = url_methods.parse(request.url, true).query;
            var action = params['action'];
            if(action) {
                if(action == "submit") {
                    serverCharacter.submitCharacterForm(request, response, db, session);
                }
                return true;
            }
        } else if(request.url.toLowerCase() == '/book-creator.html') {
            getUserSession(session['secret'], function(user){
                server_book.submitBookForm(user,request,db);
                redirect(response, '/book.html');
            });
            return true;
        }
    } else if (request.method.toLowerCase() === 'get') {
        if(url_methods.parse(request.url).pathname === '/index.html') {
            var params = url_methods.parse(request.url, true).query;
            var action = params['action'];
            if(action) {
                response.writeHead(200,{"Content-Type": "application/json"});
                if(action == "get_session") {
                    var jsonObj = JSON.stringify(session);
                    response.end(jsonObj);
                }
                return true;
            }
        } else if(url_methods.parse(request.url).pathname === '/register-login.html') {
            var params = url_methods.parse(request.url, true).query;
            var action = params['action'];
            if(action) {
                if(action == "logout") {
                    session = {'secret' : ''};
                    response.setHeader('Set-Cookie', ["secret=''"]);
                    redirect(response, '/register-login.html');
                }
                return true;
            }
        } else if(url_methods.parse(request.url).pathname === '/book.html') {
            var params = url_methods.parse(request.url, true).query;
            var action = params['action'];
            if(action) {
                response.writeHead(200,{"Content-Type": "application/json"});
                if(action === "get_books") {
                    getUserSession(session['secret'], function(user){
                        server_book.sendBooks(user,response,db);
                    });
                }
                else if(action === "get_event") {
                    getUserSession(session['secret'], function(user){
                        var book = parseInt(params['book']);
                        var page = parseInt(params['page']);
                        server_book.getAndSendEvent(user,book,page,response,db);
                    });
                }
                else if(action === "event_choice") {
                    getUserSession(session['secret'], function(user){
                        var book = parseInt(params['book']);
                        var choice = parseInt(params['choice']);
                        server_book.setOutcome(user,book,choice,response,db);
                    });
                }
                return true;
            }
        } else if(url_methods.parse(request.url).pathname === '/character-creator.html') {
            var params = url_methods.parse(request.url, true).query;
            var action = params['action'];
            if(action) {
                response.writeHead(200,{"Content-Type": "application/json"});
                if(action == "get_character") {
                    serverCharacter.loadCharacter(request, response, db, session['secret']);
                }
                return true;
            }
        }
    }
    return false;
}

function validatePassword(str, minLength, maxLength) {
    var reg = new RegExp("^(?=.*\\d)(?=.*[a-z])(?=.*[A-Z]).{"+minLength.toString()+","+maxLength.toString()+"}$");
    return reg.test(str);
}

function validateText(str, minLength, maxLength) {
    var reg = new RegExp("^(?=.*([a-z]|[A-Z]|d)).{"+minLength.toString()+","+maxLength.toString()+"}$");
    return reg.test(str);
}

function validateLogin(username, password)
{
    if (!validateText(username, 4, 32))
        return false;
    if (!validatePassword(password, 6, 32))
        return false;
    return true;
}

function validateRegister(username, email, password) {   
    if (!validateText(username, 4, 32))
        return false;
    else if (!validatePassword(password, 6, 32))
        return false;
    else if (!email)
        return false;
    return true;
}

function getUserSession(secret,callback) {
    db.all("SELECT username FROM Sessions WHERE secret = '"+secret+"'", function(err, row) {
        // Retrieve logged user's character or show default
        if (row[0])
        { 
            callback(row[0]['username']);
        }
        else {
            callback("guest");
        }
    });
}

function CSPRNGBase64 (len) {
    // Generates a CSPRN using crypto module, converted to base64 with '+' and '/' replaced by '0'
    return crypto.randomBytes(Math.ceil(len * 3 / 4)).toString('base64').slice(0, len).replace(/\+/g, '0').replace(/\//g, '0');
}

function dbErr(e) { if (e) throw e; }

function registerOrLogin(request, response)
{
    var body='';
    request.on('data', function (data) {
        body +=data;
    });
    request.on('end',function(){
        var POST =  qs.parse(body);
        console.log(POST);
        if (POST['type'] == 'login')
        {
            // Validate input
            if (validateLogin(POST['username'], POST['password']))
            {
                // Query user ID to retrieve hash table
                db.each("SELECT username, password FROM Users WHERE username = '"+POST['username']+"'", function(err, row) {
                    bcrypt.compare(POST['password'], row['password'], function(err, res) {
                        if (res)
                        {
                            createSession(row['username'], response);
                        }
                        else
                        {
                            console.log("Login Failure");
                            // Respond unsuccessful login attempt
                            response.writeHead(200,{"Content-Type": "application/json"});
                            var r = {
                                "result" : false
                            };
                            var jsonObj = JSON.stringify(r);
                            response.end(jsonObj);
                        }
                    });
                });
            } else {
                // Respond failing server side validation
                response.writeHead(200,{"Content-Type": "application/json"});
                var r = {
                    "result" : false
                };
                var jsonObj = JSON.stringify(r);
                response.end(jsonObj);
            }
        }
        else if (POST['type'] == 'register')
        {
            console.log(POST);
            // Validate input
            if (validateRegister(POST['username'], POST['email'], POST['password']))
            {
                // Check if user already exist
                db.all("SELECT username FROM Users WHERE username = '"+POST['username']+"'", function(err, rows) {
                    if(rows.length == 0) {
                        // Salt and hash password
                        bcrypt.hash(POST['password'], saltRounds, function(h_err, hash) {
                            // Create user
                            db.run("INSERT INTO Users (username, password, email) VALUES ('"+POST['username']+"', '"+hash+"', '"+POST['email']+"')", function() {
                                // Create default character for user
                                db.run("INSERT INTO Characters (username,name,hair_type,eye_type,nose_type,mouth_type,head_type,hair_tint,skin_tint,eye_tint,mouth_tint)"+
                                    "VALUES ('"+POST['username']+"','"+POST['username']+"',2,1,1,1,1,'ffffff','ffffff','ffffff','ffffff')",function(){
                                    createSession(POST['username'], response);
                                });
                            });
                        });
                    }
                    else
                    {
                        // Respond already exist
                        response.writeHead(200,{"Content-Type": "application/json"});
                        var r = {
                            "result" : false
                        };
                        var jsonObj = JSON.stringify(r);
                        response.end(jsonObj);
                    }
                });
            } else {
                // Respond failing server side validation
                response.writeHead(200,{"Content-Type": "application/json"});
                var r = {
                    "result" : false
                };
                var jsonObj = JSON.stringify(r);
                response.end(jsonObj);
            }
        }
    });
}

function createSession(username, response)
{
    // Generate secret key
    var secret = CSPRNGBase64(64); 
    response.setHeader('Set-Cookie', ["secret="+secret]);
    // Remove any possible leftover sessions of this user
    db.run("DELETE FROM Sessions WHERE username = '"+username+"'", function(e) {
        if (e) throw e;
        //db.run("INSERT INTO Sessions (secret, username, date) VALUES ('"+secret+"', '"+username+"', '"+sessionDate+"')", dbErr);
        db.run("INSERT INTO Sessions (secret, username, date) VALUES ('"+secret+"', '"+username+"', datetime('now'))", function(){
            //JSON respond redirect to character
            response.writeHead(200,{"Content-Type": "application/json"});
            var r = {
                "result" : true
            };
            var jsonObj = JSON.stringify(r);
            response.end(jsonObj);
        });
    });
}

// Find the content type (MIME type) to respond with.
// Content negotiation is used for XHTML delivery to new/old browsers.
function findType(request, extension) {
    var type = types[extension];
    if (! type) return type;
    if (extension != ".html") return type;
    var htmlTypes = types[".html"].split(", ");
    var accepts = request.headers['accept'].split(",");
    if (accepts.indexOf(htmlTypes[1]) >= 0) return htmlTypes[1];
    return htmlTypes[0];
}

// Check whether a string starts with a prefix, or ends with a suffix
function starts(s, x) { return s.lastIndexOf(x, 0) == 0; }
function ends(s, x) { return s.indexOf(x, s.length-x.length) >= 0; }

// Check that a file is inside the site.  This is essential for security.
var site = fs.realpathSync('.') + path.sep;
function inSite(file) {
    var real;
    try { real = fs.realpathSync(file); }
    catch (err) { return false; }
    return starts(real, site);
}

// Check that the case of a path matches the actual case of the files.  This is
// needed in case the target publishing site is case-sensitive, and you are
// running this server on a case-insensitive file system such as Windows or
// (usually) OS X on a Mac.  The results are not (yet) cached for efficiency.
function matchCase(file) {
    var parts = file.split('/');
    var dir = '.';
    for (var i=1; i<parts.length; i++) {
        var names = fs.readdirSync(dir);
        if (names.indexOf(parts[i]) < 0) return false;
        dir = dir + '/' + parts[i];
    }
    return true;
}

// Check that a name contains no spaces.  This is because spaces are not
// allowed in URLs without being escaped, and escaping is too confusing.
// URLS with other special characters are also not allowed.
function noSpaces(name) {
    return (name.indexOf(' ') < 0);
}

// Do a few tests.
function test() {
    if (! fs.existsSync('./public/index.html')) failTest('no index.html page found');
    if (! inSite('./public/index.html')) failTest('inSite failure 1');
    if (inSite('./../site')) failTest('inSite failure 2');
    if (! matchCase('./public/index.html')) failTest('matchCase failure');
    if (matchCase('./public/Index.html')) failTest('matchCase failure');
    if (! noSpaces('./public/index.html')) failTest('noSpaces failure');
    if (noSpaces('./my index.html')) failTest('noSpaces failure');
}

function failTest(s) {
    console.log(s);
    process.exit(1);
}

// A dummy key and certificate are provided for https.
// They should not be used on a public site because they are insecure.
// They are effectively public, which private keys should never be.
var key =
    "-----BEGIN RSA PRIVATE KEY-----\n" +
    "MIICXAIBAAKBgQDGkGjkLwOG9gkuaBFj12n+dLc+fEFk1ns60vsE1LNTDtqe87vj\n" +
    "3cTMPpsSjzZpzm1+xQs3+ayAM2+wkhdjhthWwiG2v2Ime2afde3iFzA93r4UPlQv\n" +
    "aDVET8AiweE6f092R0riPpaG3zdx6gnsnNfIEzRH3MnPUe5eGJ/TAiwxsQIDAQAB\n" +
    "AoGAGz51JdnNghb/634b5LcJtAAPpGMoFc3X2ppYFrGYaS0Akg6fGQS0m9F7NXCw\n" +
    "5pOMMniWsXdwU6a7DF7/FojJ5d+Y5nWkqyg7FRnrR5QavIdA6IQCIq8by9GRZ0LX\n" +
    "EUpgIqE/hFbbPM2v2YxMe6sO7E63CU2wzSI2aYQtWCUYKAECQQDnfABYbySAJHyR\n" +
    "uxntTeuEahryt5Z/rc0XRluF5yUGkaafiDHoxqjvirN4IJrqT/qBxv6NxvKRu9F0\n" +
    "UsQOzMpJAkEA25ff5UQRGg5IjozuccopTLxLJfTG4Ui/uQKjILGKCuvnTYHYsdaY\n" +
    "cZeVjuSJgtrz5g7EKdOi0H69/dej1cFsKQJBAIkc/wti0ekBM7QScloItH9bZhjs\n" +
    "u71nEjs+FoorDthkP6DxSDbMLVat/n4iOgCeXRCv8SnDdPzzli5js/PcQ9kCQFWX\n" +
    "0DykGGpokN2Hj1WpMAnqBvyneXHMknaB0aXnrd/t7b2nVBiVhdwY8sG80ODBiXnt\n" +
    "3YZUKM1N6a5tBD5IY2kCQDIjsE0c39OLiFFnpBwE64xTNhkptgABWzN6vY7xWRJ/\n" +
    "bbMgeh+dQH20iq+O0dDjXkWUGDfbioqtRClhcyct/qE=\n" +
    "-----END RSA PRIVATE KEY-----\n";

var cert =
    "-----BEGIN CERTIFICATE-----\n" +
    "MIIClTCCAf4CCQDwoLa5kuCqOTANBgkqhkiG9w0BAQUFADCBjjELMAkGA1UEBhMC\n" +
    "VUsxDTALBgNVBAgMBEF2b24xEDAOBgNVBAcMB0JyaXN0b2wxDDAKBgNVBAoMA1VP\n" +
    "QjEZMBcGA1UECwwQQ29tcHV0ZXIgU2NpZW5jZTESMBAGA1UEAwwJbG9jYWxob3N0\n" +
    "MSEwHwYJKoZIhvcNAQkBFhJub25lQGNzLmJyaXMuYWMudWswHhcNMTMwNDA4MDgy\n" +
    "NjE2WhcNMTUwNDA4MDgyNjE2WjCBjjELMAkGA1UEBhMCVUsxDTALBgNVBAgMBEF2\n" +
    "b24xEDAOBgNVBAcMB0JyaXN0b2wxDDAKBgNVBAoMA1VPQjEZMBcGA1UECwwQQ29t\n" +
    "cHV0ZXIgU2NpZW5jZTESMBAGA1UEAwwJbG9jYWxob3N0MSEwHwYJKoZIhvcNAQkB\n" +
    "FhJub25lQGNzLmJyaXMuYWMudWswgZ8wDQYJKoZIhvcNAQEBBQADgY0AMIGJAoGB\n" +
    "AMaQaOQvA4b2CS5oEWPXaf50tz58QWTWezrS+wTUs1MO2p7zu+PdxMw+mxKPNmnO\n" +
    "bX7FCzf5rIAzb7CSF2OG2FbCIba/YiZ7Zp917eIXMD3evhQ+VC9oNURPwCLB4Tp/\n" +
    "T3ZHSuI+lobfN3HqCeyc18gTNEfcyc9R7l4Yn9MCLDGxAgMBAAEwDQYJKoZIhvcN\n" +
    "AQEFBQADgYEAQo4j5DAC04trL3nKDm54/COAEKmT0PGg87BvC88S5sTsWTF4jZdj\n" +
    "dgxV4FeBF6hW2pnchveJK4Kh56ShKF8SK1P8wiqHqV04O9p1OrkB6GxlIO37eq1U\n" +
    "xQMaMCUsZCWPP3ujKAVL7m3HY2FQ7EJBVoqvSvqSaHfnhog3WpgdyMw=\n" +
    "-----END CERTIFICATE-----\n";

// Start everything going.
start();
