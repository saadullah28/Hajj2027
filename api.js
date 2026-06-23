const firebaseConfig = {
    apiKey: "AIzaSyAx60Z_uLSKbGirNTZPr1nWoRLQHjmXhqk",
    authDomain: "hajj-and-umrah-registration.firebaseapp.com",
    projectId: "hajj-and-umrah-registration",
    storageBucket: "hajj-and-umrah-registration.firebasestorage.app",
    messagingSenderId: "651660975458",
    appId: "1:651660975458:web:c2d8a0110d02804457203b",
    measurementId: "G-L51MDZV6TG"
};

if (typeof firebase === 'undefined') {
    throw new Error('Firebase SDK is not loaded. Make sure the Firebase scripts are included before js/api.js.');
}

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

var firestore = firebase.firestore();
var storage = typeof firebase.storage === 'function' ? firebase.storage() : null;
var partnerStateCollection = firestore.collection('partnerState');
var registrationsCollection = firestore.collection('registrations');
var quotaStateCache = null;
var quotaStatePromise = null;
var quotaCacheKey = 'hajj_quota_state_cache_v1';
var quotaCacheTtlMs = 5 * 60 * 1000;

function getCompanies() {
    if (typeof globalThis !== 'undefined' && globalThis.COMPANIES) {
        return globalThis.COMPANIES;
    }

    throw new Error('Partner directory data is not loaded. Include js/companies.js before js/api.js.');
}

function toNumber(value) {
    var number = parseInt(value, 10);
    return Number.isFinite(number) ? number : 0;
}

function getPartnerStatic(enrollmentId) {
    var companies = getCompanies();
    return companies[enrollmentId] || null;
}

function buildPartner(enrollmentId, quotaUsed) {
    var partner = getPartnerStatic(enrollmentId);
    if (!partner) {
        return null;
    }

    var quotaTotal = toNumber(partner.quota);
    var used = toNumber(quotaUsed);

    return {
        enrollmentId: enrollmentId,
        name: partner.name,
        enrollment: partner.enrollment,
        ceo: partner.ceo,
        email: partner.email,
        whatsapp: partner.whatsapp,
        quotaTotal: quotaTotal,
        quotaUsed: used,
        quotaRemaining: Math.max(0, quotaTotal - used),
        logoPosition: partner.logoPosition
    };
}

function normalizeCreatedAt(value) {
    if (typeof value === 'string') {
        return value;
    }

    if (value && typeof value.toDate === 'function') {
        return value.toDate().toISOString();
    }

    return '';
}

async function loadQuotaStateMap(forceRefresh) {
    if (!forceRefresh && quotaStateCache) {
        return quotaStateCache;
    }

    if (!forceRefresh && quotaStatePromise) {
        return quotaStatePromise;
    }

    if (!forceRefresh) {
        try {
            var cachedRaw = localStorage.getItem(quotaCacheKey);
            if (cachedRaw) {
                var cached = JSON.parse(cachedRaw);
                if (cached && cached.expiresAt > Date.now() && cached.data) {
                    quotaStateCache = cached.data;
                    return quotaStateCache;
                }
            }
        } catch (_error) {
            // Ignore cache parse/storage failures and fall back to Firestore.
        }
    }

    quotaStatePromise = partnerStateCollection.get().then(function (snapshot) {
        var map = {};
        snapshot.forEach(function (doc) {
            map[doc.id] = doc.data() || {};
        });
        quotaStateCache = map;

        try {
            localStorage.setItem(quotaCacheKey, JSON.stringify({
                expiresAt: Date.now() + quotaCacheTtlMs,
                data: map
            }));
        } catch (_error) {
            // Cache persistence is best-effort.
        }

        quotaStatePromise = null;
        return map;
    }).catch(function (error) {
        quotaStatePromise = null;
        throw error;
    });

    return quotaStatePromise;
}

function updateQuotaStateCache(enrollmentId, quotaUsed) {
    if (!quotaStateCache) {
        quotaStateCache = {};
    }

    quotaStateCache[enrollmentId] = Object.assign({}, quotaStateCache[enrollmentId], {
        quotaUsed: quotaUsed
    });
}

function extractEnrollmentId(groupName, companyName) {
    var text = (groupName || '') + ' ' + (companyName || '');
    var enrMatch = text.match(/ENR#?\s*(\d{4})/i);
    if (enrMatch) {
        return enrMatch[1];
    }

    var companies = getCompanies();
    var knownIds = Object.keys(companies);
    var numberMatches = text.match(/\b(\d{4})\b/g) || [];

    for (var i = 0; i < numberMatches.length; i += 1) {
        if (knownIds.indexOf(numberMatches[i]) !== -1) {
            return numberMatches[i];
        }
    }

    return null;
}

async function getLivePartner(enrollmentId, forceRefresh) {
    var partner = getPartnerStatic(enrollmentId);
    if (!partner) {
        return null;
    }

    var stateMap = await loadQuotaStateMap(forceRefresh);
    var quotaUsed = stateMap[enrollmentId] ? toNumber(stateMap[enrollmentId].quotaUsed) : 0;
    return buildPartner(enrollmentId, quotaUsed);
}

async function fetchPartners() {
    var companies = getCompanies();
    var stateMap = await loadQuotaStateMap(false);
    return Object.keys(companies).sort().map(function (enrollmentId) {
        var quotaUsed = stateMap[enrollmentId] ? toNumber(stateMap[enrollmentId].quotaUsed) : 0;
        return buildPartner(enrollmentId, quotaUsed);
    });
}

async function fetchPartner(enrollmentId) {
    var partner = await fetchPartnerDetails(enrollmentId);
    var registrations = await fetchPartnerRegistrations(enrollmentId);

    return {
        partner: partner,
        registrations: registrations
    };
}

async function fetchPartnerDetails(enrollmentId) {
    var partner = await getLivePartner(enrollmentId, false);
    if (!partner) {
        throw new Error('Partner not found.');
    }

    return partner;
}

async function fetchPartnerRegistrations(enrollmentId) {
    var snapshot = await registrationsCollection.where('enrollmentId', '==', enrollmentId).get();
    return snapshot.docs.map(function (doc) {
        var data = doc.data() || {};
        return {
            id: doc.id,
            group_name: data.group_name || '',
            group_size: toNumber(data.group_size),
            company_name: data.company_name || '',
            created_at: normalizeCreatedAt(data.created_at)
        };
    }).sort(function (a, b) {
        return b.created_at.localeCompare(a.created_at);
    });
}

async function checkQuotaAvailability(params) {
    var groupSize = params.groupSize;
    var groupName = params.groupName;
    var companyName = params.companyName;
    var enrollmentId = params.enrollmentId;
    var resolvedId = enrollmentId;

    if (resolvedId && !/^\d{4}$/.test(String(resolvedId))) {
        return {
            valid: false,
            message: 'Enrollment number must be a 4-digit number.'
        };
    }

    if (!resolvedId && (groupName || companyName)) {
        resolvedId = extractEnrollmentId(groupName || '', companyName || '');
    }

    if (!resolvedId) {
        return {
            valid: false,
            message: 'Enter your enrollment number to check quota availability.'
        };
    }

    var partner = await getLivePartner(resolvedId, false);
    if (!partner) {
        return {
            valid: false,
            message: 'Partner not found.'
        };
    }

    if (!groupSize) {
        return {
            valid: true,
            partner: partner,
            message: 'Remaining quota: ' + partner.quotaRemaining + ' of ' + partner.quotaTotal + '.'
        };
    }

    var size = toNumber(groupSize);
    if (!Number.isInteger(size) || size < 1) {
        return {
            valid: false,
            message: 'Group size must be a positive whole number.'
        };
    }

    if (size > partner.quotaRemaining) {
        return {
            valid: false,
            message: 'Group size (' + size + ') exceeds remaining quota (' + partner.quotaRemaining + ') for ' + partner.enrollment + '.',
            partner: partner
        };
    }

    return {
        valid: true,
        message: size + ' pilgrims fit within the remaining quota of ' + partner.quotaRemaining + '.',
        partner: partner
    };
}

function sanitizeFileName(filename) {
    return String(filename || 'hujjaj-list')
        .replace(/[\\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, '-')
        .slice(0, 120);
}

async function submitRegistration(formData) {
    var groupName = String(formData.get('group_name') || '');
    var companyName = String(formData.get('company_name') || '');
    var enrollmentId = String(formData.get('enrollment_number') || '').trim();

    if (!enrollmentId) {
        enrollmentId = extractEnrollmentId(groupName, companyName) || '';
    }

    if (!/^\d{4}$/.test(enrollmentId)) {
        throw new Error('Enrollment number must be a 4-digit number.');
    }

    var partner = getPartnerStatic(enrollmentId);
    if (!partner) {
        throw new Error('No partner found for enrollment ' + enrollmentId + '.');
    }

    var groupSize = toNumber(formData.get('group_size'));
    if (!Number.isInteger(groupSize) || groupSize < 1) {
        throw new Error('Group size must be a positive whole number.');
    }

    var quotaTotal = toNumber(partner.quota);
    var file = formData.get('hujjaj_list');
    if (!(file instanceof File)) {
        throw new Error('Hujjaj list file is required.');
    }

    if (file.size > 100 * 1024 * 1024) {
        throw new Error('Hujjaj list file must be 100 MB or smaller.');
    }

    var uploadFileName = sanitizeFileName(file.name);
    var uploadPath = 'registrations/' + enrollmentId + '/' + Date.now() + '-' + uploadFileName;
    if (!storage) {
        throw new Error('File uploads are not available because Firebase Storage is not loaded.');
    }

    var uploadRef = storage.ref().child(uploadPath);
    var uploadSnapshot;

    try {
        uploadSnapshot = await uploadRef.put(file);
        var downloadUrl = await uploadSnapshot.ref.getDownloadURL();
        var result = await firestore.runTransaction(async function (transaction) {
            var partnerRef = partnerStateCollection.doc(enrollmentId);
            var partnerDoc = await transaction.get(partnerRef);
            var currentQuotaUsed = partnerDoc.exists ? toNumber(partnerDoc.data().quotaUsed) : 0;
            var remaining = quotaTotal - currentQuotaUsed;

            if (groupSize > remaining) {
                var quotaError = new Error(
                    'Group size (' + groupSize + ') exceeds remaining quota (' + remaining + ') for ' + partner.enrollment + '. Allocated quota is ' + quotaTotal + '.'
                );
                quotaError.status = 400;
                throw quotaError;
            }

            var nowIso = new Date().toISOString();
            var registrationRef = registrationsCollection.doc();

            transaction.set(partnerRef, {
                enrollmentId: enrollmentId,
                quotaUsed: currentQuotaUsed + groupSize,
                updated_at: nowIso
            }, {
                merge: true
            });

            transaction.set(registrationRef, {
                id: registrationRef.id,
                enrollmentId: enrollmentId,
                enrollment_number: enrollmentId,
                email: String(formData.get('email') || ''),
                company_name: companyName,
                group_name: groupName,
                group_size: groupSize,
                arrival_date: String(formData.get('arrival_date') || ''),
                makkah_contract: String(formData.get('makkah_contract') || ''),
                madinah_contract: String(formData.get('madinah_contract') || ''),
                basic_contract: String(formData.get('basic_contract') || ''),
                camp_contract: String(formData.get('camp_contract') || ''),
                arrival: String(formData.get('arrival') || ''),
                mashaer: String(formData.get('mashaer') || ''),
                intercity_transport: String(formData.get('intercity_transport') || ''),
                departure: String(formData.get('departure') || ''),
                hujjaj_list_filename: file.name,
                hujjaj_list_url: downloadUrl,
                created_at: nowIso
            });

            return {
                registrationId: registrationRef.id,
                enrollmentId: enrollmentId,
                groupSize: groupSize,
                partner: buildPartner(enrollmentId, currentQuotaUsed + groupSize)
            };
        });

        updateQuotaStateCache(enrollmentId, result.partner.quotaUsed);
        return {
            message: 'Registration submitted successfully.',
            registrationId: result.registrationId,
            enrollmentId: result.enrollmentId,
            groupSize: result.groupSize,
            partner: result.partner
        };
    } catch (error) {
        if (uploadRef) {
            await uploadRef.delete().catch(function () {
                return null;
            });
        }

        if (error && error.status) {
            throw error;
        }

        throw new Error(error && error.message ? error.message : 'Registration failed. Please try again.');
    }
}

function getRegistrationDisplayValue(value) {
    var text = String(value == null ? '' : value).trim();
    return text || '-';
}

function getRegistrationPdfLabel(value) {
    if (value === 'jed_mak') return 'JED-MAK';
    if (value === 'med_airport_med') return 'MED AIRPORT - MED';
    if (value === 'radwahid') return 'RADWAHID';
    if (value === 'radeen') return 'RADEEN';
    if (value === 'mak_med') return 'MAK-MED';
    if (value === 'med_mak') return 'MED-MAK';
    if (value === 'mak_jed') return 'MAK-JED';
    if (value === 'med_med_airport') return 'MED - MED AIRPORT';
    return getRegistrationDisplayValue(value);
}

function buildRegistrationPdfData(formData, result) {
    return {
        registrationId: result && result.registrationId ? result.registrationId : '',
        enrollmentId: result && result.enrollmentId ? result.enrollmentId : '',
        submittedAt: new Date().toISOString(),
        partner: result && result.partner ? result.partner : null,
        fields: [
            { label: 'Enrollment Number', value: formData.get('enrollment_number') },
            { label: 'Email', value: formData.get('email') },
            { label: 'Company Name', value: formData.get('company_name') },
            { label: 'Group Name', value: formData.get('group_name') },
            { label: 'Group Size', value: formData.get('group_size') },
            { label: 'Arrival in K.S.A', value: formData.get('arrival_date') },
            { label: 'Makkah / Aziziah Contract #', value: formData.get('makkah_contract') },
            { label: 'Madinah Contract #', value: formData.get('madinah_contract') },
            { label: 'Basic Contract #', value: formData.get('basic_contract') },
            { label: 'Camp Contract #', value: formData.get('camp_contract') },
            { label: 'Arrival', value: getRegistrationPdfLabel(formData.get('arrival')) },
            { label: 'Mashaer', value: getRegistrationPdfLabel(formData.get('mashaer')) },
            { label: 'Intercity Transport', value: getRegistrationPdfLabel(formData.get('intercity_transport')) },
            { label: 'Departure', value: getRegistrationPdfLabel(formData.get('departure')) },
            { label: 'Hujjaj List', value: formData.get('hujjaj_list') && formData.get('hujjaj_list').name ? formData.get('hujjaj_list').name : '' }
        ]
    };
}

function getRegistrationPdfFilename(result) {
    var registrationId = result && result.registrationId ? result.registrationId : 'registration';
    return 'registration-' + registrationId + '.pdf';
}

function ensureJsPdf() {
    var jspdfRoot = globalThis.jspdf || (globalThis.window && globalThis.window.jspdf);
    if (!jspdfRoot || !jspdfRoot.jsPDF) {
        throw new Error('PDF generation is unavailable because jsPDF is not loaded.');
    }

    return jspdfRoot.jsPDF;
}

function formatPdfDate(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return getRegistrationDisplayValue(value);
    }

    return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

function normalizePdfText(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onload = function () {
            var result = String(reader.result || '');
            var commaIndex = result.indexOf(',');
            resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
        };
        reader.onerror = function () {
            reject(reader.error || new Error('Could not read generated PDF.'));
        };
        reader.readAsDataURL(blob);
    });
}

function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () {
        URL.revokeObjectURL(url);
    }, 1000);
}

function createRegistrationPdfBlob(formData, result) {
    var JsPDF = ensureJsPdf();
    var pdfData = buildRegistrationPdfData(formData, result);
    var doc = new JsPDF({
        unit: 'pt',
        format: 'a4'
    });

    var pageWidth = doc.internal.pageSize.getWidth();
    var pageHeight = doc.internal.pageSize.getHeight();
    var margin = 44;
    var y = 56;
    var accent = [19, 96, 63];
    var title = 'Registration Confirmation';
    var subtitle = 'Sacred Path Hajj 2026/2027';
    var sections = [
        { label: 'Registration ID', value: normalizePdfText(pdfData.registrationId) || 'Pending' },
        { label: 'Enrollment ID', value: normalizePdfText(pdfData.enrollmentId) || '---' },
        { label: 'Submitted At', value: formatPdfDate(pdfData.submittedAt) }
    ].concat(pdfData.fields);

    doc.setFillColor(accent[0], accent[1], accent[2]);
    doc.rect(0, 0, pageWidth, 100, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.text(title, margin, 42);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'normal');
    doc.text(subtitle, margin, 62);

    doc.setTextColor(33, 37, 41);
    doc.setDrawColor(220, 224, 228);
    doc.setLineWidth(1);
    doc.roundedRect(margin, 122, pageWidth - (margin * 2), 48, 10, 10, 'S');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Submission Summary', margin + 16, 144);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text('This document was generated automatically after a successful registration submission.', margin + 16, 160, {
        maxWidth: pageWidth - (margin * 2) - 32
    });

    y = 198;
    sections.forEach(function (item) {
        if (y > pageHeight - 72) {
            doc.addPage();
            y = 56;
        }

        var value = normalizePdfText(item.value);
        var wrappedValue = value ? doc.splitTextToSize(value, pageWidth - (margin * 2) - 170) : ['---'];
        var rowHeight = Math.max(24, wrappedValue.length * 13);

        doc.setDrawColor(232, 236, 240);
        doc.line(margin, y - 6, pageWidth - margin, y - 6);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text(item.label, margin, y + 4);
        doc.setFont('helvetica', 'normal');
        doc.text(wrappedValue, margin + 160, y + 4);
        y += rowHeight + 6;
    });

    if (pdfData.partner) {
        if (y > pageHeight - 120) {
            doc.addPage();
            y = 56;
        }

        doc.setDrawColor(232, 236, 240);
        doc.line(margin, y, pageWidth - margin, y);
        y += 22;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.text('Quota Details', margin, y);
        y += 18;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.text('Partner: ' + normalizePdfText(pdfData.partner.enrollment), margin, y);
        y += 14;
        doc.text('Remaining Quota: ' + normalizePdfText(pdfData.partner.quotaRemaining), margin, y);
        y += 14;
    }

    doc.setFontSize(9);
    doc.setTextColor(108, 117, 125);
    doc.text('Keep this file for your records.', margin, pageHeight - 28);

    return doc.output('blob');
}

function downloadRegistrationPdf(formData, result) {
    var blob = createRegistrationPdfBlob(formData, result);
    downloadBlob(blob, getRegistrationPdfFilename(result));
    return blob;
}

