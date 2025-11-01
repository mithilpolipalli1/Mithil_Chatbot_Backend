// server.js
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt'); // We still use this to hash the "default" password
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const saltRounds = 10;

// --- Price List (in Rupees) ---
const priceList = {
    'haircut': 500.00,
    'hair coloring': 800.00,
    'facial': 400.00,
    'manicure': 300.00,
    'pedicure': 350.00,
    'spa treatment': 1000.00,
    'combo: haircut + facial': 800.00,
    'combo: manicure + pedicure': 600.00
};

// --- Helper function to calculate total price ---
// We add a new parameter 'isFirstBooking'
function calculateTotalPrice(serviceNames, appointmentDate, isFirstBooking = false) {
    let totalPrice = 0;
    let weekendOfferApplied = false;
    let firstBookingOfferApplied = false;
    let services = [...serviceNames];

    // 1. Check for Combos
    if (services.includes('manicure') && services.includes('pedicure')) { totalPrice += priceList['combo: manicure + pedicure']; services.splice(services.indexOf('manicure'), 1); services.splice(services.indexOf('pedicure'), 1); }
    if (services.includes('haircut') && services.includes('facial')) { totalPrice += priceList['combo: haircut + facial']; services.splice(services.indexOf('haircut'), 1); services.splice(services.indexOf('facial'), 1); }

    // 2. Add remaining individual services
    services.forEach(service => { if (priceList[service]) totalPrice += priceList[service]; });

    // 3. Check for Weekend Offer (Sat/Sun)
    const date = new Date(appointmentDate.replace(/-/g, '/'));
    const dayOfWeek = date.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        weekendOfferApplied = true;
        totalPrice = totalPrice * 0.90; // Apply 10% discount
    }

    // 4. Check for First Booking Offer (50% off)
    // This is applied *after* the weekend discount
    if (isFirstBooking) {
        firstBookingOfferApplied = true;
        totalPrice = totalPrice * 0.50; // Apply 50% discount
    }

    return {
        finalPrice: parseFloat(totalPrice.toFixed(2)),
        offerApplied: weekendOfferApplied,
        firstBookingOfferApplied: firstBookingOfferApplied
    };
}


// === Customer Routes ===

// 1. CHECK IF A CUSTOMER EXISTS
// (This is now the main "login" check)
app.post('/check-user', async (req, res) => {
    const { phone } = req.body;
    try {
        const result = await db.query('SELECT * FROM salon_users WHERE phone = $1', [phone]);
        if (result.rows.length > 0) {
            res.json({ exists: true, name: result.rows[0].name });
        } else {
            res.json({ exists: false });
        }
    } catch (err) {
        console.error("Check User Error:", err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 2. REGISTER A NEW CUSTOMER
// (Slightly updated to just hash a default password)
app.post('/register', async (req, res) => {
    const { phone, name, password } = req.body; // 'password' will be "whatsapp_user"
    try {
        // We still hash the default password for database consistency
        const password_hash = await bcrypt.hash(password, saltRounds); 
        
        const result = await db.query(
            'INSERT INTO salon_users (phone, name, password_hash) VALUES ($1, $2, $3) RETURNING *',
            [phone, name, password_hash]
        );
        res.json({ success: true, user: { phone: result.rows[0].phone, name: result.rows[0].name } });
    } catch (err) {
        console.error("Register Error:", err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// 3. BOOK A NEW APPOINTMENT
// (Updated to check for first booking)
app.post('/book-appointment', async (req, res) => {
    const { user_phone, services, location, date, time } = req.body;

    let isFirstBooking = false;
    try {
        // Check if this user has any *other* bookings. 
        // We check for bookings with status 'booked' or 'cancelled'
        const bookingCheck = await db.query("SELECT 1 FROM appointments WHERE user_phone = $1 AND (status = 'booked' OR status = 'cancelled') LIMIT 1", [user_phone]);
        if (bookingCheck.rows.length === 0) {
            isFirstBooking = true; // This is their first appointment
        }
    } catch(err) {
        console.error("Error checking first booking:", err);
    }

    // Calculate price, passing the isFirstBooking flag
    const { finalPrice, offerApplied, firstBookingOfferApplied } = calculateTotalPrice(services, date, isFirstBooking);
    
    const servicesString = services.join(', ');

    try {
        const result = await db.query(
            'INSERT INTO appointments (user_phone, services, location, appointment_date, appointment_time, total_price, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
            [user_phone, servicesString, location, date, time, finalPrice, 'booked']
        );
        res.json({
            success: true,
            appointment: result.rows[0],
            priceDetails: {
                totalPrice: finalPrice,
                offerApplied: offerApplied,
                firstBookingOfferApplied: firstBookingOfferApplied // Send this back to the bot
            }
        });
    } catch (err) {
        console.error("Booking Error:", err);
        res.status(500).json({ error: 'Booking failed' });
    }
});


// 4. GET A CUSTOMER'S UPCOMING APPOINTMENTS
app.post('/get-appointments', async (req, res) => {
    const { user_phone } = req.body;
    try {
        const result = await db.query(
            "SELECT * FROM appointments WHERE user_phone = $1 AND status = 'booked' ORDER BY appointment_date, appointment_time",
            [user_phone]
        );
        res.json({ success: true, appointments: result.rows });
    } catch (err) {
        console.error("Get Appointments Error:", err);
        res.status(500).json({ error: 'Database error' });
    }
});

// 5. CANCEL AN APPOINTMENT
app.post('/cancel-appointment', async (req, res) => {
    const { appointment_id } = req.body;
    try {
        const result = await db.query(
            "UPDATE appointments SET status = 'cancelled' WHERE appointment_id = $1 RETURNING *",
            [appointment_id]
        );
        res.json({ success: true, cancelled_appointment: result.rows[0] });
    } catch (err) {
        console.error("Cancel Appointment Error:", err);
        res.status(500).json({ error: 'Database error' });
    }
});


// === Admin Route ===

// 6. GET ALL APPOINTMENTS (FOR ADMIN)
// (This route is still needed for the admin view)
app.get('/get-all-appointments', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT a.appointment_id, a.user_phone, u.name AS customer_name, a.services, a.location,
                    a.appointment_date, a.appointment_time, a.total_price, a.status
             FROM appointments a JOIN salon_users u ON a.user_phone = u.phone
             ORDER BY a.appointment_date DESC, a.appointment_time DESC`
        );
        res.json({ success: true, appointments: result.rows });
    } catch (err) {
        console.error("Get All Appointments Error:", err);
        res.status(500).json({ error: 'Database error fetching all appointments' });
    }
});


// === REMOVED ROUTES ===
// app.post('/login', ...) is no longer needed
// app.post('/admin-login', ...) is no longer needed


// Start the server
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});